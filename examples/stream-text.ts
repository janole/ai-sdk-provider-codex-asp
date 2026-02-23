import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Check the local repository just quickly. What it is about?",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

console.log("\n");
await codex.shutdown();
