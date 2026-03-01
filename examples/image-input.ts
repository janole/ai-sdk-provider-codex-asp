/**
 * Image input with generateText().
 *
 * Pass a local image file as the first argument:
 *   npx tsx examples/image-input.ts ./screenshot.png
 *   npx tsx examples/image-input.ts ./photo.jpg "What colors do you see?"
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { generateText } from "ai";

import { createCodexAppServer } from "../src/provider";

const imagePath = process.argv[2];
if (!imagePath)
{
    console.error("Usage: npx tsx examples/image-input.ts <image-file> [prompt]");
    process.exit(1);
}

const prompt = process.argv[3] ?? "Describe this image.";

const ext = basename(imagePath).split(".").pop()?.toLowerCase() ?? "";
const mediaTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    tiff: "image/tiff",
};
const mediaType = mediaTypes[ext];
if (!mediaType)
{
    console.error(`Unsupported image format: .${ext}`);
    process.exit(1);
}

const imageData = readFileSync(imagePath);

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

const result = await generateText({
    model: codex.languageModel("gpt-5.3-codex"),
    messages: [
        {
            role: "user",
            content: [
                { type: "text", text: prompt },
                { type: "image", image: imageData, mediaType },
            ],
        },
    ],
});

console.log(result.text);

await codex.shutdown();
