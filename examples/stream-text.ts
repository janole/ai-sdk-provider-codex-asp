import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
    clientInfo: { name: "@janole/codex-ai-sdk-provider", version: "0.1.0" },
});

const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Explain JSON-RPC in one paragraph.",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}
