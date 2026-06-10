/**
 * Non-streaming text generation with generateText().
 *
 * Run with:
 *   npx tsx examples/generate-text.ts
 */

import { generateText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.5",
});

const result = await generateText({
    model: codex.languageModel("gpt-5.5"),
    prompt: "Hello, who are you?",
});

console.log(result.text);

await codex.shutdown();
