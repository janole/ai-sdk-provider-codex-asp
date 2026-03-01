/**
 * Discover available models via the app-server protocol.
 *
 * Run with:
 *   npx tsx examples/list-models.ts
 */

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer();

const models = await codex.listModels();

for (const model of models)
{
    const modalities = model.inputModalities.join(", ");
    const efforts = model.supportedReasoningEfforts
        .map((e) => e.reasoningEffort)
        .join(", ");

    console.log(`${model.isDefault ? "* " : "  "}${model.id}`);
    console.log(`    ${model.displayName} — ${model.description}`);
    console.log(`    modalities: ${modalities}`);
    console.log(`    reasoning efforts: ${efforts} (default: ${model.defaultReasoningEffort})`);
    console.log();
}

await codex.shutdown();
