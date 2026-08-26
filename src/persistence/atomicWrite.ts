import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writes by staging to a sibling temp file and renaming over the target, so a
 * reader never observes a partially written file. Rename is atomic within the
 * same filesystem, which the temp file guarantees by living alongside it.
 */
export const atomicWriteFile = async (
  filePath: string,
  data: string | Uint8Array,
): Promise<void> => {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, data);
  await rename(tmpPath, filePath);
};
