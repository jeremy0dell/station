import { readFile, rm, stat } from "node:fs/promises";

export async function readTextFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

export async function removeFileIfPresent(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}
