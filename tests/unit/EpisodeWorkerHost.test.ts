import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { EpisodeWorkerHost } from "../../src/engine/process/EpisodeWorkerHost.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("EpisodeWorkerHost", () => {
  test("clears the deadline after a successful response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bbgm-worker-host-"));
    tempDirectories.push(directory);
    const workerScript = join(directory, "echo-worker.mjs");
    await writeFile(
      workerScript,
      'import { parentPort } from "node:worker_threads"; parentPort.on("message", (request) => parentPort.postMessage({ id: request.id, result: request.method }));',
      "utf8",
    );

    const host = new EpisodeWorkerHost({
      workerScript,
      workerData: {},
      callTimeoutMs: 500,
    });
    try {
      await expect(host.call("first")).resolves.toBe("first");
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(host.call("second")).resolves.toBe("second");
    } finally {
      await host.terminate();
    }
  });

  test("restores structured domain fields from an RPC error response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bbgm-worker-host-"));
    tempDirectories.push(directory);
    const workerScript = join(directory, "error-worker.mjs");
    await writeFile(
      workerScript,
      'import { parentPort } from "node:worker_threads"; parentPort.on("message", (request) => parentPort.postMessage({ id: request.id, error: { message: "Player refused", code: "ILLEGAL_ACTION", retryable: false, rollbackRequired: false, details: { pid: 42 } } }));',
      "utf8",
    );

    const host = new EpisodeWorkerHost({
      workerScript,
      workerData: {},
    });
    try {
      await expect(host.call("reject")).rejects.toMatchObject({
        message: "Player refused",
        code: "ILLEGAL_ACTION",
        retryable: false,
        rollbackRequired: false,
        details: { pid: 42 },
      });
    } finally {
      await host.terminate();
    }
  });

  test("times out a hung call and quarantines the worker for later calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bbgm-worker-host-"));
    tempDirectories.push(directory);
    const workerScript = join(directory, "hung-worker.mjs");
    await writeFile(
      workerScript,
      'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});',
      "utf8",
    );

    const host = new EpisodeWorkerHost({
      workerScript,
      workerData: {},
      callTimeoutMs: 25,
    });
    try {
      await expect(host.call("hang")).rejects.toMatchObject({
        code: "TIMEOUT",
        retryable: true,
      });
      await expect(host.call("hang")).rejects.toMatchObject({
        code: "TIMEOUT",
        retryable: true,
      });
    } finally {
      await host.terminate();
    }
  });
});
