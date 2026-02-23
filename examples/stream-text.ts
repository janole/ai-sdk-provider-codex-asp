import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Explain JSON-RPC in one paragraph.",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}
