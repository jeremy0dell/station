import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { E2bConfig } from "@station/config";
import type { RuntimeArtifact } from "@station/e2b";
import { runExternalCommand, stationBuildInfo } from "@station/runtime";
import { z } from "zod";
import { resolveExactNativeRelease } from "./update/githubRelease.js";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const ManifestSchema = z
  .object({
    version: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    buildIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    target: z.literal("linux-x64"),
  })
  .strict();

async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || response.body === null) throw new Error("Cloud runtime download failed.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > limit) throw new Error("Cloud runtime download exceeded its limit.");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * ADAPTER
 *
 * Resolves and verifies a Linux runtime before compute creation. Released clients use their
 * exact immutable release; development archives require a checksum and embedded source manifest.
 */
export async function resolveExecutionRuntime(
  config: E2bConfig,
): Promise<{ artifact: RuntimeArtifact; archive: Uint8Array }> {
  let archive: Buffer;
  let expected: string;
  let artifact: RuntimeArtifact;
  if (config.runtimeArchive !== undefined && config.runtimeArchiveSha256 !== undefined) {
    const path = resolve(config.runtimeArchive);
    if ((await stat(path)).size > MAX_ARCHIVE_BYTES)
      throw new Error("Cloud runtime archive exceeds 256 MiB.");
    archive = await readFile(path);
    expected = config.runtimeArchiveSha256;
    if (createHash("sha256").update(archive).digest("hex") !== expected)
      throw new Error("Cloud runtime checksum mismatch.");
    const directory = await mkdtemp(join(tmpdir(), "station-cloud-runtime-"));
    try {
      const verifiedPath = join(directory, "runtime.tar.gz");
      await writeFile(verifiedPath, archive, { mode: 0o600 });
      const manifest = await runExternalCommand({
        command: "tar",
        args: ["-xOzf", verifiedPath, "runtime-manifest.json"],
        timeoutMs: 15000,
        maxOutputChars: 16384,
      });
      const parsed = ManifestSchema.parse(JSON.parse(manifest.stdout));
      artifact = {
        sha256: expected,
        version: parsed.version,
        sourceCommit: parsed.sourceCommit,
        buildIdentity: parsed.buildIdentity,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else {
    const info = stationBuildInfo();
    if (!info.compiled)
      throw new Error(
        "Development E2B launches require runtime_archive and runtime_archive_sha256.",
      );
    const release = await resolveExactNativeRelease(`v${info.version}`);
    const asset = release.assets.archive["linux-x64"];
    const sums = (await download(release.assets.checksums.url, 65536)).toString("utf8");
    const matches = sums
      .split("\n")
      .filter((line) => line.slice(66) === asset.name && /^[a-f0-9]{64} {2}/.test(line));
    if (matches.length !== 1 || matches[0] === undefined)
      throw new Error("Cloud runtime checksum is missing or ambiguous.");
    expected = matches[0].slice(0, 64);
    archive = await download(asset.url, MAX_ARCHIVE_BYTES);
    artifact = { sha256: expected, version: release.version };
  }
  if (
    archive.length > MAX_ARCHIVE_BYTES ||
    createHash("sha256").update(archive).digest("hex") !== expected
  )
    throw new Error("Cloud runtime checksum mismatch.");
  return { artifact, archive };
}
