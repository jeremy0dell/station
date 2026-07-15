import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  createPiHarnessReadinessProvider,
  type PiHarnessReadinessProviderOptions,
} from "../../src/readiness";

describe("Pi harness readiness", () => {
  it("distinguishes available, missing, and indeterminate CLIs without authentication", async () => {
    const extensionPath = await validExtension();
    await expect(providerWithRunner(extensionPath, versionRunner()).probe()).resolves.toMatchObject(
      {
        cli: "available",
        installedVersion: "1.2.3",
        authentication: "not_applicable",
        launchability: "ready",
        trackingSetup: "prepared",
      },
    );
    await expect(
      providerWithRunner(extensionPath, async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }).probe(),
    ).resolves.toMatchObject({ cli: "missing", launchability: "blocked" });
    await expect(
      providerWithRunner(extensionPath, async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }).probe(),
    ).resolves.toMatchObject({ cli: "unknown", launchability: "unknown" });
  });

  it("redirects Pi state and disables startup network activity", async () => {
    const extensionPath = await validExtension();
    let isolatedHome = "";
    await providerWithRunner(extensionPath, async (input) => {
      isolatedHome = input.env?.HOME ?? "";
      expect(input.cwd).toContain("station-readiness-");
      expect(input.env).toMatchObject({
        PI_CODING_AGENT_DIR: expect.stringContaining("station-readiness-"),
        PI_CODING_AGENT_SESSION_DIR: expect.stringContaining("provider/sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      });
      return result(input, "pi 1.2.3\n");
    }).probe();

    await expect(access(isolatedHome)).rejects.toThrow();
  });

  it("accepts regular non-empty extensions and validates content-addressed paths without writes", async () => {
    const contents = Buffer.from("export default function stationPi() {}\n");
    const root = await mkdtemp(join(tmpdir(), "station-pi-readiness-"));
    const hash = createHash("sha256").update(contents).digest("hex");
    const extensionPath = join(root, `0.8.0-${hash}`, "station-pi-extension.mjs");
    await mkdir(join(root, `0.8.0-${hash}`), { recursive: true });
    await writeFile(extensionPath, contents);

    await expect(probeWithoutWrites(root, extensionPath)).resolves.toMatchObject({
      trackingSetup: "prepared",
    });

    const mismatchedPath = join(root, `0.8.0-${"0".repeat(64)}`, "station-pi-extension.mjs");
    await mkdir(join(root, `0.8.0-${"0".repeat(64)}`), { recursive: true });
    await writeFile(mismatchedPath, contents);
    await expect(probeWithoutWrites(root, mismatchedPath)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
      technicalDetails: [
        {
          code: "HARNESS_PI_EXTENSION_INVALID",
          message: "Station's Pi extension is invalid; reinstall Station.",
        },
      ],
    });
  });

  it("reports missing, empty, and non-regular extensions as Station repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-pi-readiness-"));
    const missing = join(root, "missing.mjs");
    await expect(probeWithoutWrites(root, missing)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
      technicalDetails: [expect.objectContaining({ code: "HARNESS_PI_EXTENSION_MISSING" })],
    });

    const empty = join(root, "empty.mjs");
    await writeFile(empty, "");
    await expect(probeWithoutWrites(root, empty)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
      technicalDetails: [expect.objectContaining({ code: "HARNESS_PI_EXTENSION_INVALID" })],
    });

    const target = join(root, "target.mjs");
    const linked = join(root, "linked.mjs");
    await writeFile(target, "export default {}\n");
    await symlink(target, linked);
    await expect(probeWithoutWrites(root, linked)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
      technicalDetails: [expect.objectContaining({ code: "HARNESS_PI_EXTENSION_INVALID" })],
    });
  });

  it("keeps indeterminate extension inspection unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-pi-readiness-"));
    const path = join(root, "x".repeat(1024));

    await expect(probeWithoutWrites(root, path)).resolves.toMatchObject({
      trackingSetup: "unknown",
      technicalDetails: [
        {
          code: "ENAMETOOLONG",
          message: "Station's Pi extension could not be inspected.",
        },
      ],
    });
  });
});

function providerWithRunner(
  extensionPath: string,
  runner: NonNullable<PiHarnessReadinessProviderOptions["runner"]>,
) {
  return createPiHarnessReadinessProvider({ extensionPath, command: "pi-test", runner });
}

function versionRunner() {
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> =>
    result(input, "pi 1.2.3\n");
}

async function validExtension(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-pi-readiness-"));
  const path = join(root, "piExtension.mjs");
  await writeFile(path, "export default function stationPi() {}\n");
  return path;
}

async function probeWithoutWrites(root: string, extensionPath: string) {
  const before = await snapshotTree(root);
  const facts = await createPiHarnessReadinessProvider({
    extensionPath,
    command: "pi-test",
    runner: versionRunner(),
  }).probe();
  expect(await snapshotTree(root)).toEqual(before);
  return facts;
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    const absolute = join(root, path);
    const stats = await lstat(absolute);
    snapshot[path] = stats.isFile()
      ? (await readFile(absolute)).toString("base64")
      : stats.isSymbolicLink()
        ? "symlink"
        : "directory";
  }
  return snapshot;
}

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return { command: input.command, args: input.args ?? [], stdout, stderr: "", exitCode: 0 };
}
