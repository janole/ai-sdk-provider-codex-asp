import { generateText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

const result = await generateText({
    model: codex.languageModel("gpt-5.3-codex"),
    prompt: "Check the local repository just quickly. What it is about?",
});

console.log(result.text);
