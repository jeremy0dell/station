import { access, lstat, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { installOpenCodePlugin, resolveOpenCodePluginPath } from "../../src/pluginInstall";
import {
  createOpenCodeHarnessReadinessProvider,
  type OpenCodeHarnessReadinessProviderOptions,
} from "../../src/readiness";

describe("OpenCode harness readiness", () => {
  it("distinguishes available, missing, and indeterminate CLIs", async () => {
    await expect(providerWithRunner(versionRunner()).probe()).resolves.toMatchObject({
      cli: "available",
      installedVersion: "1.15.12",
      authentication: "unknown",
      launchability: "ready",
    });
    await expect(
      providerWithRunner(async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }).probe(),
    ).resolves.toMatchObject({ cli: "missing", launchability: "blocked" });
    await expect(
      providerWithRunner(async () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      }).probe(),
    ).resolves.toMatchObject({ cli: "unknown", launchability: "unknown" });
  });

  it("redirects OpenCode config, data, and update state", async () => {
    let isolatedHome = "";
    await providerWithRunner(async (input) => {
      isolatedHome = input.env?.HOME ?? "";
      expect(input.cwd).toContain("station-readiness-");
      expect(input.env).toMatchObject({
        OPENCODE_CONFIG: expect.stringContaining("provider/opencode.json"),
        OPENCODE_CONFIG_DIR: expect.stringContaining("station-readiness-"),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PRUNE: "true",
        XDG_DATA_HOME: expect.stringContaining("station-readiness-"),
      });
      return result(input, "1.15.12\n");
    }).probe();

    await expect(access(isolatedHome)).rejects.toThrow();
  });

  it("classifies exact, absent, drifted, disabled, and failed plugin inspection without writes", async () => {
    const absent = await tempOptions(true);
    await expect(probeWithoutWrites(absent)).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const exact = await tempOptions(true);
    await installOpenCodePlugin(exact);
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({ trackingSetup: "prepared" });

    await downgradeGeneratedArtifact(resolveOpenCodePluginPath(exact));
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
    });

    await expect(probeWithoutWrites({ ...exact, installHooks: false })).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const failed = await tempOptions(true);
    failed.pluginPath = failed.homeDir;
    await expect(probeWithoutWrites(failed)).resolves.toMatchObject({
      trackingSetup: "unknown",
      technicalDetails: [expect.objectContaining({ code: expect.any(String) })],
    });
  });
});

async function downgradeGeneratedArtifact(path: string): Promise<void> {
  const current = await readFile(path, "utf8");
  expect(current).toContain("0.8.0");
  await writeFile(path, current.replaceAll("0.8.0", "0.7.0"), "utf8");
}

function providerWithRunner(
  runner: NonNullable<OpenCodeHarnessReadinessProviderOptions["runner"]>,
) {
  return createOpenCodeHarnessReadinessProvider({ runner, installHooks: false, env: {} });
}

function versionRunner() {
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> =>
    result(input, "1.15.12\n");
}

async function tempOptions(
  installHooks: boolean,
): Promise<OpenCodeHarnessReadinessProviderOptions & { homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "station-opencode-readiness-"));
  return {
    command: "opencode-test",
    runner: versionRunner(),
    installHooks,
    homeDir,
    env: {},
    opencodeConfigDir: join(homeDir, "opencode"),
    stateDir: join(homeDir, "state"),
    observerSocketPath: join(homeDir, "run", "observer.sock"),
    hookSpoolDir: join(homeDir, "state", "spool", "hooks"),
  };
}

async function probeWithoutWrites(options: OpenCodeHarnessReadinessProviderOptions) {
  const root = options.homeDir;
  if (root === undefined) throw new Error("readiness fixture requires a temporary home");
  const before = await snapshotTree(root);
  const facts = await createOpenCodeHarnessReadinessProvider(options).probe();
  expect(await snapshotTree(root)).toEqual(before);
  return facts;
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    const absolute = join(root, path);
    const stats = await lstat(absolute);
    snapshot[path] = stats.isFile() ? (await readFile(absolute)).toString("base64") : "directory";
  }
  return snapshot;
}

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return { command: input.command, args: input.args ?? [], stdout, stderr: "", exitCode: 0 };
}
