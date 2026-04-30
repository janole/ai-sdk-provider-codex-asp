import path from "node:path";

import { describe, expect, it } from "vitest";

import { StdioTransport } from "../src/client/transport-stdio";

describe("StdioTransport", () => 
{
    it("spawns a process and exchanges JSONL messages", async () => 
    {
        const fixturePath = path.resolve(process.cwd(), "tests/fixtures/rpc-echo.mjs");

        const transport = new StdioTransport({
            command: process.execPath,
            args: [fixturePath],
        });

        const messagePromise = new Promise<unknown>((resolve) => 
        {
            const off = transport.on("message", (message) => 
            {
                off();
                resolve(message);
            });
        });

        await transport.connect();
        await transport.sendMessage({ id: 1, method: "initialize", params: {} });

        const response = await messagePromise;
        expect(response).toEqual({
            id: 1,
            result: {
                ok: true,
                method: "initialize",
            },
        });

        await transport.disconnect();
    });

    it("does not treat stderr output as a transport error", async () =>
    {
        const transport = new StdioTransport({
            command: process.execPath,
            args: ["-e", [
                "import readline from 'node:readline';",
                "process.stderr.write('startup warning\\n');",
                "const rl = readline.createInterface({ input: process.stdin });",
                "rl.on('line', (line) => {",
                "  const message = JSON.parse(line);",
                "  process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');",
                "});",
            ].join("")],
        });

        const errors: unknown[] = [];
        const offError = transport.on("error", (error) =>
        {
            errors.push(error);
        });

        const messagePromise = new Promise<unknown>((resolve) =>
        {
            const offMessage = transport.on("message", (message) =>
            {
                offMessage();
                resolve(message);
            });
        });

        await transport.connect();
        await transport.sendMessage({ id: 1, method: "initialize", params: {} });

        await expect(messagePromise).resolves.toEqual({
            id: 1,
            result: { ok: true },
        });
        expect(errors).toEqual([]);

        offError();
        await transport.disconnect();
    });

    it("reports buffered stderr when the process exits unsuccessfully", async () =>
    {
        const transport = new StdioTransport({
            command: process.execPath,
            args: ["-e", "process.stderr.write('fatal details\\n'); process.exit(2);"],
        });

        const errorPromise = new Promise<unknown>((resolve) =>
        {
            const off = transport.on("error", (error) =>
            {
                off();
                resolve(error);
            });
        });

        await transport.connect();

        const error = await errorPromise;

        expect(error).toBeInstanceOf(Error);

        if (!(error instanceof Error))
        {
            throw new TypeError("Expected transport error to be an Error instance.");
        }

        expect(error.message).toContain("fatal details");
    });
});
