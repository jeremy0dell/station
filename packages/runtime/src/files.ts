import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type ReplaceTextFileOptions = {
  path: string;
  contents: string;
  mode: number;
  directoryMode?: number;
};

export async function replaceTextFile(options: ReplaceTextFileOptions): Promise<void> {
  const targetPath = await existingReplaceTarget(options.path);
  const directory = dirname(targetPath);
  const temporaryPath = join(directory, `.${basename(targetPath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
  try {
    await writeFile(temporaryPath, options.contents, {
      encoding: "utf8",
      flag: "wx",
      mode: options.mode,
    });
    await chmod(temporaryPath, options.mode);
    await rename(temporaryPath, targetPath);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function existingReplaceTarget(path: string): Promise<string> {
  // Follow live symlinks like writeFile; reject dangling links instead of replacing them.
  try {
    return await realpath(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cause;
    }
  }
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Cannot replace dangling symbolic link: ${path}`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cause;
    }
  }
  return path;
}

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

/** Visits every regular file under a root in name order, treating a missing root as empty. */
export async function walkFiles(root: string, visit: (path: string) => void): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(path, visit);
    else if (entry.isFile()) visit(path);
  }
}
