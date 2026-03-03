import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3Content,
    LanguageModelV3GenerateResult,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

import { CodexProviderError } from "./errors";
import type { CodexProviderSettings } from "./provider-settings";
import { createStreamSession } from "./stream/session";
import { EMPTY_USAGE, stripUndefined } from "./utils/object";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CodexLanguageModelSettings
{
    // intentionally empty — settings will be added as the API evolves
}

export type { CodexThreadDefaults, CodexTurnDefaults } from "./provider-settings";

export interface CodexModelConfig
{
    provider: string;
    providerSettings: Readonly<CodexProviderSettings>;
}

type PassThroughStreamContentPart = Extract<
    LanguageModelV3StreamPart,
    { type: "tool-call" | "tool-result" | "file" | "source" | "tool-approval-request" }
>;

function isPassThroughContentPart(
    part: LanguageModelV3StreamPart,
): part is PassThroughStreamContentPart
{
    switch (part.type)
    {
        case "tool-call":
        case "tool-result":
        case "file":
        case "source":
        case "tool-approval-request":
            return true;
        default:
            return false;
    }
}

export class CodexLanguageModel implements LanguageModelV3
{
    readonly specificationVersion = "v3" as const;
    readonly provider: string;
    readonly modelId: string;
    readonly supportedUrls: Record<string, RegExp[]> = {};

    private readonly settings: CodexLanguageModelSettings;
    private readonly config: CodexModelConfig;

    constructor(
        modelId: string,
        settings: CodexLanguageModelSettings,
        config: CodexModelConfig,
    )
    {
        this.modelId = modelId;
        this.settings = settings;
        this.config = config;
        this.provider = config.provider;
    }

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult>
    {
        void this.settings;

        const streamResult = await this.doStream(options);
        const reader = streamResult.stream.getReader();

        const textOrder: string[] = [];
        const textById = new Map<string, string>();
        const passThroughContent: LanguageModelV3Content[] = [];

        let warnings: LanguageModelV3GenerateResult["warnings"] = [];
        let finishReason: LanguageModelV3GenerateResult["finishReason"] = {
            unified: "other",
            raw: undefined,
        };
        let usage: LanguageModelV3Usage = EMPTY_USAGE;
        let providerMetadata: LanguageModelV3GenerateResult["providerMetadata"];

        while (true)
        {
            const { value, done } = await reader.read();
            if (done)
            {
                break;
            }

            if (value.type === "stream-start")
            {
                warnings = value.warnings;
                continue;
            }

            if (value.type === "text-start")
            {
                if (!textById.has(value.id))
                {
                    textOrder.push(value.id);
                    textById.set(value.id, "");
                }
                continue;
            }

            if (value.type === "text-delta")
            {
                if (!textById.has(value.id))
                {
                    textOrder.push(value.id);
                    textById.set(value.id, value.delta);
                }
                else
                {
                    textById.set(value.id, `${textById.get(value.id) ?? ""}${value.delta}`);
                }
                continue;
            }

            if (value.type === "finish")
            {
                finishReason = value.finishReason;
                usage = value.usage;
                providerMetadata = value.providerMetadata;
                continue;
            }

            if (value.type === "error")
            {
                if (value.error instanceof Error)
                {
                    throw value.error;
                }

                throw new CodexProviderError("Generation stream emitted an error.", {
                    cause: value.error,
                });
            }

            if (isPassThroughContentPart(value))
            {
                passThroughContent.push(value);
            }
        }

        const textContent: LanguageModelV3Content[] = textOrder
            .map((id) =>
            {
                const text = textById.get(id) ?? "";
                if (text.length === 0)
                {
                    return null;
                }

                return stripUndefined({
                    type: "text" as const,
                    text,
                    providerMetadata,
                });
            })
            .filter((part): part is Extract<LanguageModelV3Content, { type: "text" }> => part !== null);

        return stripUndefined({
            content: [...textContent, ...passThroughContent],
            finishReason,
            usage,
            warnings,
            providerMetadata,
            request: streamResult.request,
        });
    }

    doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult>
    {
        return createStreamSession(this.config, this.modelId, options);
    }
}
