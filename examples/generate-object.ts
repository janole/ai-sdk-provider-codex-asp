/**
 * Structured output with generateText() + Output.object().
 *
 * Run with:
 *   npx tsx examples/generate-object.ts
 */

import { generateText, Output } from "ai";
import { z } from "zod";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

const result = await generateText({
    model: codex.languageModel("gpt-5.3-codex"),
    prompt: "Give me a short summary of TypeScript in 2 sentences with a confidence score.",
    output: Output.object({
        name: "summary_response",
        description: "Structured response with summary text and confidence score.",
        schema: z.object({
            summary: z.string().describe("Two-sentence summary."),
            confidence: z.number().min(0).max(1).describe("Confidence between 0 and 1."),
        }),
    }),
});

const parsed = z.object({
    summary: z.string(),
    confidence: z.number().min(0).max(1),
}).safeParse(result.output);

if (!parsed.success)
{
    console.error("Structured output validation failed:");
    console.error(parsed.error.flatten());
    await codex.shutdown();
    process.exit(1);
}

console.log(JSON.stringify(result.output, null, 2));
console.log("Validation: structured output works (schema matched).");

await codex.shutdown();
