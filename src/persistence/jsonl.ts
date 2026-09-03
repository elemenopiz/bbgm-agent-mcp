import { readFile } from "node:fs/promises";

export class CorruptJsonlError extends Error {
  readonly code = "PERSISTENCE_ERROR" as const;

  constructor(label: string) {
    super(`Corrupt ${label} audit log`);
    this.name = "CorruptJsonlError";
  }
}

/**
 * Recover the next sequence number from an append-only JSONL audit log.
 *
 * Writers always terminate records with a newline. An unterminated final
 * line, malformed JSON, foreign episode ID, duplicate sequence, or backwards
 * sequence is treated as corruption rather than silently discarded. This is
 * intentionally fail-closed: research artifacts must not look complete when
 * their audit trail is damaged.
 */
export const recoverJsonlSequence = async (
  path: string,
  episodeId: string,
  label: string,
): Promise<number> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  if (raw.length === 0) return 0;
  if (!raw.endsWith("\n")) throw new CorruptJsonlError(label);

  let nextSequence = 0;
  let previousSequence = -1;
  const seen = new Set<number>();
  const lines = raw.split("\n");
  for (const line of lines.slice(0, -1)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CorruptJsonlError(label);
    }
    if (!value || typeof value !== "object") {
      throw new CorruptJsonlError(label);
    }
    const envelope = value as {
      episodeId?: unknown;
      sequence?: unknown;
    };
    if (
      envelope.episodeId !== episodeId ||
      typeof envelope.sequence !== "number" ||
      !Number.isSafeInteger(envelope.sequence) ||
      envelope.sequence < 0 ||
      envelope.sequence <= previousSequence ||
      seen.has(envelope.sequence)
    ) {
      throw new CorruptJsonlError(label);
    }
    seen.add(envelope.sequence);
    previousSequence = envelope.sequence;
    nextSequence = envelope.sequence + 1;
  }
  return nextSequence;
};
