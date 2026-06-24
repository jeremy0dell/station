import { statSync } from "node:fs";

/**
 * True only when `path` is an existing directory. A saved spawn cwd that now
 * points at a regular file (or is gone, or is unreadable) is NOT restorable, so
 * any stat failure and any non-directory entry resolves to false.
 */
export function savedCwdExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
