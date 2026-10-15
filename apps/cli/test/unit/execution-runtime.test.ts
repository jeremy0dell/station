import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2bConfigSchema } from "@station/config";
import { runExternalCommand } from "@station/runtime";
import { expect, it } from "vitest";
import { resolveExecutionRuntime } from "../../src/executionRuntime.js";

it("verifies a development archive and its source/platform manifest before compute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-test-"));
  try {
    const path = join(directory, "runtime.tar.gz");
    await writeFile(
      join(directory, "runtime-manifest.json"),
      JSON.stringify({
        version: "test",
        sourceCommit: "a".repeat(40),
        buildIdentity: "b".repeat(64),
        target: "linux-x64",
      }),
    );
    await runExternalCommand({
      command: "tar",
      args: ["-czf", path, "-C", directory, "runtime-manifest.json"],
      timeoutMs: 15000,
    });
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const config = E2bConfigSchema.parse({ runtimeArchive: path, runtimeArchiveSha256: sha256 });
    expect((await resolveExecutionRuntime(config)).artifact).toEqual({
      version: "test",
      sourceCommit: "a".repeat(40),
      buildIdentity: "b".repeat(64),
      sha256,
    });
    await writeFile(path, "replaced");
    await expect(resolveExecutionRuntime(config)).rejects.toThrow(/checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("requires both development archive settings", () => {
  expect(E2bConfigSchema.safeParse({ runtimeArchive: "/runtime.tar.gz" }).success).toBe(false);
  expect(E2bConfigSchema.safeParse({ runtimeArchiveSha256: "a".repeat(64) }).success).toBe(false);
});
