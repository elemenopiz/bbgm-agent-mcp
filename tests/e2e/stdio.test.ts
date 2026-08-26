import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, test } from "vitest";

const cliPath = resolve(import.meta.dirname, "../../dist/cli.js");
const built = existsSync(cliPath);

/**
 * Exercises the actual compiled binary (never tsx) over a real stdio
 * transport, as a spawned child process. Requires `pnpm build` to have run
 * first; skips (rather than failing) if dist/cli.js is missing so `pnpm
 * test:unit` etc. don't require a build.
 */
describe.skipIf(!built)("spawned stdio server", () => {
  test("tools/list works, every tool advertises schemas, invalid args error cleanly, and stdout carries no logs", async () => {
    let stderrOutput = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      stderr: "pipe",
      env: {
        ...process.env,
        BBGM_DATA_ROOT: resolve(import.meta.dirname, "../../.data-e2e-test"),
      },
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString("utf8");
    });

    const client = new Client({ name: "e2e-stdio-test", version: "1.0.0" });
    try {
      // A successful connect+listTools round trip is itself strong evidence stdout carried only
      // valid JSON-RPC framing: any stray text on stdout (e.g. a console.log) would corrupt the
      // frame and this would fail to parse rather than resolve.
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.length).toBe(13);
      for (const tool of listed.tools) {
        expect(tool.inputSchema, tool.name).toBeDefined();
        expect(tool.outputSchema, tool.name).toBeDefined();
      }

      const invalid = await client.callTool({
        name: "bbgm_create_episode",
        arguments: { scenarioId: "", seed: "" },
      });
      expect(invalid.isError).toBe(true);

      // Diagnostics do land on stderr, confirming the process is actually logging (just not to stdout).
      expect(stderrOutput).toMatch(/listening on stdio/);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);
});
