import { access, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { installCodexHooks, resolveCodexHookScriptPath } from "../../src/hooks";
import {
  type CodexHarnessReadinessProviderOptions,
  createCodexHarnessReadinessProvider,
} from "../../src/readiness";

describe("Codex harness readiness", () => {
  it("keeps CLI and authentication evidence independent", async () => {
    await expect(providerWithRunner(codexRunner(0)).probe()).resolves.toMatchObject({
      cli: "available",
      installedVersion: "0.32.1",
      authentication: "ready",
      launchability: "ready",
    });
    await expect(providerWithRunner(codexRunner(1)).probe()).resolves.toMatchObject({
      cli: "available",
      authentication: "required",
      launchability: "blocked",
    });
    await expect(
      providerWithRunner(async (input) => {
        if (input.command === "npm") return result(input, "0.33.0\n");
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }).probe(),
    ).resolves.toMatchObject({ cli: "missing", authentication: "unknown" });
    await expect(
      providerWithRunner(async (input) => {
        if (input.command === "npm") return result(input, "0.33.0\n");
        if (input.args?.[0] === "--version") {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        throw Object.assign(new Error("failed"), { exitCode: 2 });
      }).probe(),
    ).resolves.toMatchObject({
      cli: "unknown",
      authentication: "unknown",
      launchability: "unknown",
    });
  });

  it("runs version and auth with the same private credential copy", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "station-codex-auth-readiness-"));
    const sourceHome = join(homeDir, ".codex");
    const sourceAuth = join(sourceHome, "auth.json");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(sourceAuth, '{"tokens":{"access_token":"test"}}\n', { mode: 0o600 });
    await writeFile(
      join(sourceHome, "config.toml"),
      'cli_auth_credentials_store = "file"\nlog_dir = "/real/user/logs"\n',
      { mode: 0o600 },
    );
    const calls: Array<{ args: string[]; auth: string; cwd: string; codexHome: string }> = [];

    const readiness = await createCodexHarnessReadinessProvider({
      command: "codex-test",
      env: {},
      homeDir,
      installHooks: false,
      runner: async (input) => {
        if (input.command === "npm") {
          return result(input, "0.33.0\n");
        }
        const codexHome = input.env?.CODEX_HOME;
        if (codexHome === undefined || input.cwd === undefined) {
          throw new Error("readiness command was not isolated");
        }
        calls.push({
          args: input.args ?? [],
          auth: await readFile(join(codexHome, "auth.json"), "utf8"),
          cwd: input.cwd,
          codexHome,
        });
        return result(
          input,
          input.args?.[0] === "--version" ? "codex-cli 0.32.1\n" : "Logged in\n",
        );
      },
    }).probe();

    expect(readiness).toMatchObject({ cli: "available", authentication: "ready" });
    expect(calls.map((call) => call.args)).toEqual(
      expect.arrayContaining([
        ["--version"],
        ["-c", 'cli_auth_credentials_store="file"', "login", "status"],
      ]),
    );
    expect(new Set(calls.map((call) => call.codexHome)).size).toBe(1);
    expect(new Set(calls.map((call) => call.cwd)).size).toBe(1);
    expect(calls.every((call) => call.auth.includes("access_token"))).toBe(true);
    expect(await readFile(sourceAuth, "utf8")).toContain("access_token");
    await expect(access(calls[0]?.codexHome ?? "")).rejects.toThrow();
  });

  it("does not misreport home-keyed keyring authentication", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "station-codex-auth-readiness-"));
    const sourceHome = join(homeDir, ".codex");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(join(sourceHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');

    await expect(
      createCodexHarnessReadinessProvider({
        command: "codex-test",
        env: {},
        homeDir,
        installHooks: false,
        runner: async (input) => {
          if (input.command === "npm") return result(input, "0.33.0\n");
          if (input.args?.[0] === "--version") return result(input, "codex-cli 0.32.1\n");
          throw new Error("keyring auth must not be probed from a different CODEX_HOME");
        },
      }).probe(),
    ).resolves.toMatchObject({
      cli: "available",
      authentication: "unknown",
      technicalDetails: [
        expect.objectContaining({ code: "HARNESS_CODEX_AUTH_STORE_UNINSPECTABLE" }),
      ],
    });
  });

  it("keeps CLI evidence when credential seeding fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "station-codex-auth-readiness-"));
    await mkdir(join(homeDir, ".codex", "auth.json"), { recursive: true });

    await expect(
      createCodexHarnessReadinessProvider({
        command: "codex-test",
        env: {},
        homeDir,
        installHooks: false,
        runner: codexRunner(0),
      }).probe(),
    ).resolves.toMatchObject({
      cli: "available",
      installedVersion: "0.32.1",
      authentication: "unknown",
      technicalDetails: [expect.objectContaining({ code: "HARNESS_CODEX_AUTH_SEED_FAILED" })],
    });
  });

  it("classifies exact, absent, drifted, disabled, and failed hook inspection without writes", async () => {
    const absent = await tempOptions(true);
    await expect(probeWithoutWrites(absent)).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const exact = await tempOptions(true);
    await installCodexHooks(exact);
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({ trackingSetup: "prepared" });

    await embedRetiredSchema(resolveCodexHookScriptPath(exact));
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
    });

    await expect(probeWithoutWrites({ ...exact, installHooks: false })).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const failed = await tempOptions(true);
    failed.codexConfigPath = failed.homeDir;
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

function providerWithRunner(runner: NonNullable<CodexHarnessReadinessProviderOptions["runner"]>) {
  return createCodexHarnessReadinessProvider({ runner, installHooks: false, env: {} });
}

function codexRunner(loginExitCode: number) {
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
    if (input.command === "npm") return result(input, "0.33.0\n");
    if (input.args?.[0] === "--version") return result(input, "codex-cli 0.32.1\n");
    return {
      ...result(input, loginExitCode === 0 ? "Logged in\n" : "Not logged in\n"),
      exitCode: loginExitCode,
    };
  };
}

async function tempOptions(
  installHooks: boolean,
): Promise<CodexHarnessReadinessProviderOptions & { homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "station-codex-readiness-"));
  return {
    command: "codex-test",
    runner: codexRunner(0),
    installHooks,
    homeDir,
    env: {},
    stateDir: join(homeDir, "state"),
    observerSocketPath: join(homeDir, "run", "observer.sock"),
    hookSpoolDir: join(homeDir, "state", "spool", "hooks"),
    stationConfigPath: join(homeDir, "station.toml"),
  };
}

async function probeWithoutWrites(options: CodexHarnessReadinessProviderOptions) {
  const root = options.homeDir;
  if (root === undefined) throw new Error("readiness fixture requires a temporary home");
  const before = await snapshotTree(root);
  const facts = await createCodexHarnessReadinessProvider(options).probe();
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
