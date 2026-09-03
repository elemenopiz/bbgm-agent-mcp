import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, test } from "vitest";

const cliPath = resolve(import.meta.dirname, "../../dist/cli.js");
const built = existsSync(cliPath);
const runRealEngine = process.env["BBGM_REAL_ENGINE"] === "1";

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
      expect(listed.tools.length).toBe(18);
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

  test("supports the modern 2026-07-28 stdio discovery path", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      stderr: "pipe",
      env: {
        ...process.env,
        BBGM_DATA_ROOT: resolve(
          import.meta.dirname,
          "../../.data-e2e-modern-test",
        ),
      },
    });
    const client = new Client(
      { name: "e2e-modern-stdio-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: { pin: "2026-07-28" },
        },
      },
    );
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(18);
      expect(
        listed.tools.every((tool) => tool.inputSchema && tool.outputSchema),
      ).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);

  describe.skipIf(!runRealEngine)("real engine lifecycle", () => {
    test(
      "creates, advances, and ends an engine-backed episode over spawned stdio",
      { timeout: 180_000 },
      async () => {
        const dataRoot = await mkdtemp(
          join(tmpdir(), "bbgm-stdio-real-engine-"),
        );
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [cliPath],
          stderr: "ignore",
          env: {
            ...process.env,
            BBGM_REAL_ENGINE: "1",
            BBGM_DATA_ROOT: dataRoot,
          },
        });
        const client = new Client({
          name: "e2e-real-engine-stdio-test",
          version: "1.0.0",
        });

        try {
          await client.connect(transport);

          const created = await client.callTool({
            name: "bbgm_create_episode",
            arguments: {
              scenarioId: "stdio-real-engine-lifecycle",
              seed: "stdio-real-engine-seed",
              userTeamId: 0,
              startingSeason: 2026,
            },
          });
          expect(created.isError).not.toBe(true);
          const overview = created.structuredContent as {
            episodeId: string;
            revision: number;
            status: string;
            rosterCount: number;
          };
          expect(overview.status).toBe("active");
          expect(overview.rosterCount).toBeGreaterThan(0);

          const advanced = await client.callTool({
            name: "bbgm_advance",
            arguments: {
              episodeId: overview.episodeId,
              expectedRevision: overview.revision,
              idempotencyKey: "stdio-real-engine-advance-0001",
              target: "next_game",
            },
          });
          expect(advanced.isError).not.toBe(true);
          const mutation = advanced.structuredContent as {
            previousRevision: number;
            revision: number;
            stateSummary: { episodeId: string };
          };
          expect(mutation.previousRevision).toBe(overview.revision);
          expect(mutation.revision).toBe(overview.revision + 1);
          expect(mutation.stateSummary.episodeId).toBe(overview.episodeId);

          const ended = await client.callTool({
            name: "bbgm_end_episode",
            arguments: {
              episodeId: overview.episodeId,
              exportFinalSnapshot: false,
            },
          });
          expect(ended.isError).not.toBe(true);
          expect(
            (ended.structuredContent as { finalState: { status: string } })
              .finalState.status,
          ).toBe("ended");
        } finally {
          await client.close().catch(() => undefined);
          await rm(dataRoot, { recursive: true, force: true });
        }
      },
    );
  });
});
