import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savedCwdExists } from "./savedCwdExists.js";

const made: string[] = [];

afterEach(() => {
  for (const path of made.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "saved-cwd-"));
  made.push(dir);
  return dir;
}

describe("savedCwdExists", () => {
  it("returns true for an existing directory", () => {
    expect(savedCwdExists(tmpDir())).toBe(true);
  });

  it("returns false for a path that no longer exists", () => {
    const dir = tmpDir();
    rmSync(dir, { recursive: true, force: true });
    expect(savedCwdExists(dir)).toBe(false);
  });

  it("returns false for a path that is a regular file, not a directory", () => {
    const file = join(tmpDir(), "not-a-dir.txt");
    writeFileSync(file, "x");
    expect(savedCwdExists(file)).toBe(false);
  });
});
