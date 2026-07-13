import { access, lstat, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { installCursorHooks, resolveCursorHookScriptPath } from "../../src/hooks";
import {
  type CursorHarnessReadinessProviderOptions,
  createCursorHarnessReadinessProvider,
} from "../../src/readiness";

describe("Cursor harness readiness", () => {
  it("distinguishes available, missing, and indeterminate CLIs", async () => {
    await expect(providerWithRunner(versionRunner()).probe()).resolves.toMatchObject({
      cli: "available",
      installedVersion: "2026.06.02-8c11d9f",
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
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }).probe(),
    ).resolves.toMatchObject({ cli: "unknown", launchability: "unknown" });
  });

  it("redirects Cursor config and compile-cache paths", async () => {
    let isolatedHome = "";
    await providerWithRunner(async (input) => {
      isolatedHome = input.env?.HOME ?? "";
      expect(input.cwd).toContain("station-readiness-");
      expect(input.env).toMatchObject({
        STATION_CURSOR_HOME: expect.stringContaining("station-readiness-"),
        XDG_CONFIG_HOME: expect.stringContaining("station-readiness-"),
        NODE_COMPILE_CACHE: expect.stringContaining("station-readiness-"),
      });
      return result(input, "2026.06.02-8c11d9f\n");
    }).probe();

    await expect(access(isolatedHome)).rejects.toThrow();
  });

  it("classifies exact, absent, drifted, disabled, and failed hook inspection without writes", async () => {
    const absent = await tempOptions(true);
    await expect(probeWithoutWrites(absent)).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const exact = await tempOptions(true);
    await installCursorHooks({
      ...exact,
      ...(exact.configPath === undefined ? {} : { stationConfigPath: exact.configPath }),
    });
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({ trackingSetup: "prepared" });

    await embedRetiredSchema(resolveCursorHookScriptPath(exact));
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
    });

    await expect(probeWithoutWrites({ ...exact, installHooks: false })).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const failed = await tempOptions(true);
    failed.cursorHooksPath = failed.homeDir;
    await expect(probeWithoutWrites(failed)).resolves.toMatchObject({
      trackingSetup: "unknown",
      technicalDetails: [expect.objectContaining({ code: expect.any(String) })],
    });
  });
});

async function embedRetiredSchema(path: string): Promise<void> {
  const current = await readFile(path, "utf8");
  await writeFile(path, `${current}# retired station schema 0.7.0\n`, "utf8");
}

function providerWithRunner(runner: NonNullable<CursorHarnessReadinessProviderOptions["runner"]>) {
  return createCursorHarnessReadinessProvider({ runner, installHooks: false, env: {} });
}

function versionRunner() {
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> =>
    result(input, "2026.06.02-8c11d9f\n");
}

async function tempOptions(
  installHooks: boolean,
): Promise<CursorHarnessReadinessProviderOptions & { homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "station-cursor-readiness-"));
  return {
    command: "agent-test",
    runner: versionRunner(),
    installHooks,
    homeDir,
    env: {},
    stateDir: join(homeDir, "state"),
    observerSocketPath: join(homeDir, "run", "observer.sock"),
    hookSpoolDir: join(homeDir, "state", "spool", "hooks"),
    configPath: join(homeDir, "station.toml"),
  };
}

async function probeWithoutWrites(options: CursorHarnessReadinessProviderOptions) {
  const root = options.homeDir;
  if (root === undefined) throw new Error("readiness fixture requires a temporary home");
  const before = await snapshotTree(root);
  const facts = await createCursorHarnessReadinessProvider(options).probe();
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
