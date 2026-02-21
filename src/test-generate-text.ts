import { generateText } from "ai";

import { createCodexAppServer } from "./provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
    clientInfo: { name: "@janole/codex-ai-sdk-provider", version: "0.1.0" },
});

const result = await generateText({
    model: codex.languageModel("gpt-5.3-codex"),
    prompt: "Check the local repository just quickly. What it is about?",
});

console.log(result.text);
