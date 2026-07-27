import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { CodexEventMapper } from "../src/protocol/event-mapper";

interface RolloutUsage
{
    total_tokens: number;
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
}

interface RolloutLine
{
    type: string;
    payload?: {
        type: string;
        info?: {
            total_token_usage: RolloutUsage;
            last_token_usage: RolloutUsage | null;
            model_context_window: number | null;
        };
    };
}

function toBreakdown(u: RolloutUsage)
{
    return {
        totalTokens: u.total_tokens,
        inputTokens: u.input_tokens,
        cachedInputTokens: u.cached_input_tokens,
        cacheWriteInputTokens: u.cache_write_input_tokens,
        outputTokens: u.output_tokens,
        reasoningOutputTokens: u.reasoning_output_tokens,
    };
}

/**
 * Replays a real Codex rollout through the mapper and checks that the usage we
 * report back to the AI SDK reconciles exactly with Codex's own cumulative
 * total. This is the regression guard for the `last`-vs-`total` undercount:
 * against a 17-turn / 263-request session, reporting `last` yielded 7.1% of the
 * true input tokens.
 *
 * Skipped unless CODEX_ROLLOUT points at a rollout .jsonl, e.g.
 *   CODEX_ROLLOUT=~/.codex/sessions/<y>/<m>/<d>/rollout-<...>.jsonl npm test
 */
describe("rollout replay", () =>
{
    const rollout = process.env.CODEX_ROLLOUT;

    it.skipIf(!rollout)("reconciles summed step usage with the Codex thread total", () =>
    {
        const lines = fs.readFileSync(rollout as string, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as RolloutLine);

        let mapper: CodexEventMapper | undefined;
        let summedInput = 0;
        let summedCacheRead = 0;
        let codexInput = 0;
        let codexCacheRead = 0;

        const closeStep = (): void =>
        {
            const usage = mapper?.getUsage();
            summedInput += usage?.inputTokens.total ?? 0;
            summedCacheRead += usage?.inputTokens.cacheRead ?? 0;
            mapper = undefined;
        };

        for (const line of lines)
        {
            const payload = line.payload;
            if (line.type !== "event_msg" || !payload)
            {
                continue;
            }

            if (payload.type === "task_started")
            {
                mapper = new CodexEventMapper();
                continue;
            }

            if (payload.type === "task_complete")
            {
                closeStep();
                continue;
            }

            const info = payload.info;
            if (payload.type !== "token_count" || !info?.last_token_usage || !mapper)
            {
                continue;
            }

            codexInput = info.total_token_usage.input_tokens;
            codexCacheRead = info.total_token_usage.cached_input_tokens;

            mapper.map({
                method: "thread/tokenUsage/updated",
                params: {
                    threadId: "thr",
                    turnId: "turn",
                    tokenUsage: {
                        total: toBreakdown(info.total_token_usage),
                        last: toBreakdown(info.last_token_usage),
                        modelContextWindow: info.model_context_window,
                    },
                },
            });
        }

        closeStep();

        expect(summedInput).toBe(codexInput);
        expect(summedCacheRead).toBe(codexCacheRead);
    });
});
