import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const isDirectorySyncUnsupported = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EPERM";
};

const syncDirectory = async (directory: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Directory fsync is supported on the POSIX filesystems used in
    // production, but some platforms reject opening a directory as a file.
    // The file itself has already been fsynced, so retain the old atomic
    // behavior on those platforms rather than making every write fail.
    if (!isDirectorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

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
  let renamed = false;
  try {
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
    renamed = true;
    await syncDirectory(dir);
  } finally {
    if (!renamed) await unlink(tmpPath).catch(() => undefined);
  }
};
