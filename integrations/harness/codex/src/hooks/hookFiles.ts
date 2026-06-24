import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathExists, readTextFileIfPresent, removeFileIfPresent } from "@station/runtime";
import { CodexHookSetupError } from "./hookErrors.js";

export async function readOptionalFile(path: string): Promise<string> {
  try {
    return (await readTextFileIfPresent(path)) ?? "";
  } catch (cause) {
    throw new CodexHookSetupError(
      "CODEX_HOOK_CONFIG_UNREADABLE",
      "Codex hook config could not be read.",
      { cause },
    );
  }
}

export async function writeHookConfig(path: string, contents: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { mode: 0o600 });
  } catch (cause) {
    throw new CodexHookSetupError(
      "CODEX_HOOK_WRITE_FAILED",
      "Codex hook config could not be written.",
      { cause },
    );
  }
}

export async function writeHookScript(path: string, contents: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { mode: 0o700 });
    await chmod(path, 0o700);
  } catch (cause) {
    throw new CodexHookSetupError(
      "CODEX_HOOK_WRITE_FAILED",
      "Codex hook script could not be written.",
      { cause },
    );
  }
}

export async function removeHookScriptIfPresent(path: string): Promise<boolean> {
  try {
    return await removeFileIfPresent(path);
  } catch (cause) {
    throw new CodexHookSetupError(
      "CODEX_HOOK_WRITE_FAILED",
      "Codex hook script could not be removed.",
      { cause },
    );
  }
}

export async function backupIfPresent(path: string): Promise<string | undefined> {
  try {
    if (!(await pathExists(path))) {
      return undefined;
    }
  } catch (cause) {
    throw new CodexHookSetupError(
      "CODEX_HOOK_CONFIG_UNREADABLE",
      "Codex hook config metadata could not be read.",
      { cause },
    );
  }
  const backupPath = `${path}.bak.${new Date().toISOString().replaceAll(/[^0-9]/g, "")}`;
  try {
    await copyFile(path, backupPath);
  } catch (cause) {
    throw new CodexHookSetupError(
      "CODEX_HOOK_WRITE_FAILED",
      "Codex hook config backup could not be written.",
      { cause },
    );
  }
  return backupPath;
}
