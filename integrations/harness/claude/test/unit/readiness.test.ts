import { access, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { installClaudeHooks, resolveClaudeHookScriptPath } from "../../src/hooks";
import {
  type ClaudeHarnessReadinessProviderOptions,
  createClaudeHarnessReadinessProvider,
  parseClaudeAuthStatus,
} from "../../src/readiness";

describe("Claude harness readiness", () => {
  it("keeps CLI and authentication evidence independent", async () => {
    await expect(providerWithRunner(claudeRunner()).probe()).resolves.toMatchObject({
      cli: "available",
      installedVersion: "2.1.173",
      authentication: "ready",
      launchability: "ready",
    });
    await expect(
      providerWithRunner(async (input) => {
        if (input.command === "npm") return result(input, "2.2.0\n");
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }).probe(),
    ).resolves.toMatchObject({
      cli: "missing",
      authentication: "unknown",
      launchability: "blocked",
    });
    await expect(
      providerWithRunner(async (input) => {
        if (input.command === "npm") return result(input, "2.2.0\n");
        if (input.args?.[0] === "--version") {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        throw Object.assign(new Error("not logged in"), {
          exitCode: 1,
          stdout: '{"loggedIn": false}\n',
        });
      }).probe(),
    ).resolves.toMatchObject({
      cli: "unknown",
      authentication: "required",
      launchability: "blocked",
    });
    await expect(
      providerWithRunner(claudeRunner('{"loggedIn": true, "extra": "raw"}\n')).probe(),
    ).resolves.toMatchObject({ cli: "available", authentication: "unknown" });
  });

  it("parses only the strict provider-local auth status shape", () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true);
    expect(parseClaudeAuthStatus('{"loggedIn":false}')).toBe(false);
    expect(parseClaudeAuthStatus('{"loggedIn":true,"providerData":{}}')).toBeUndefined();
    expect(parseClaudeAuthStatus("not json")).toBeUndefined();
  });

  it("redirects provider state and copies file credentials privately", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "station-claude-auth-readiness-"));
    const sourceHome = join(homeDir, ".claude");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(join(sourceHome, "settings.json"), '{"apiKeyHelper":"auth-helper"}\n', {
      mode: 0o600,
    });
    await writeFile(join(sourceHome, ".credentials.json"), '{"accessToken":"test"}\n', {
      mode: 0o600,
    });
    let isolatedHome = "";

    await createClaudeHarnessReadinessProvider({
      command: "claude-test",
      env: {},
      homeDir,
      installHooks: false,
      runner: async (input) => {
        if (input.command === "npm") return result(input, "2.2.0\n");
        isolatedHome = input.env?.CLAUDE_CONFIG_DIR ?? "";
        expect(input.cwd).toContain("station-readiness-");
        expect(input.env).toMatchObject({
          CLAUDE_CODE_TMPDIR: expect.stringContaining("station-readiness-"),
          DISABLE_AUTOUPDATER: "1",
        });
        expect(await readFile(join(isolatedHome, ".credentials.json"), "utf8")).toContain(
          "accessToken",
        );
        expect(await readFile(join(isolatedHome, "settings.json"), "utf8")).toContain(
          "apiKeyHelper",
        );
        return result(
          input,
          input.args?.[0] === "--version" ? "2.1.173 (Claude Code)\n" : '{"loggedIn":true}\n',
        );
      },
    }).probe();

    await expect(access(isolatedHome)).rejects.toThrow();
  });

  it("keeps CLI evidence when credential seeding fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "station-claude-auth-readiness-"));
    await mkdir(join(homeDir, ".claude", ".credentials.json"), { recursive: true });

    await expect(
      createClaudeHarnessReadinessProvider({
        command: "claude-test",
        env: {},
        homeDir,
        installHooks: false,
        runner: claudeRunner(),
      }).probe(),
    ).resolves.toMatchObject({
      cli: "available",
      installedVersion: "2.1.173",
      authentication: "unknown",
      technicalDetails: [expect.objectContaining({ code: "HARNESS_CLAUDE_AUTH_SEED_FAILED" })],
    });
  });

  it("classifies exact, absent, drifted, disabled, and failed hook inspection without writes", async () => {
    const absent = await tempOptions(true);
    await expect(probeWithoutWrites(absent)).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const exact = await tempOptions(true);
    await installClaudeHooks(exact);
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({ trackingSetup: "prepared" });

    await embedRetiredSchema(resolveClaudeHookScriptPath(exact));
    await expect(probeWithoutWrites(exact)).resolves.toMatchObject({
      trackingSetup: "repair_needed",
    });

    await expect(probeWithoutWrites({ ...exact, installHooks: false })).resolves.toMatchObject({
      trackingSetup: "needs_preparation",
    });

    const failed = await tempOptions(true);
    failed.claudeSettingsPath = failed.homeDir;
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

function providerWithRunner(runner: NonNullable<ClaudeHarnessReadinessProviderOptions["runner"]>) {
  return createClaudeHarnessReadinessProvider({ runner, installHooks: false, env: {} });
}

function claudeRunner(auth = '{"loggedIn": true, "authMethod": "claude.ai"}\n') {
  return async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
    if (input.command === "npm") return result(input, "2.2.0\n");
    return result(input, input.args?.[0] === "--version" ? "2.1.173 (Claude Code)\n" : auth);
  };
}

async function tempOptions(
  installHooks: boolean,
): Promise<ClaudeHarnessReadinessProviderOptions & { homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "station-claude-readiness-"));
  return {
    command: "claude-test",
    runner: claudeRunner(),
    installHooks,
    homeDir,
    env: {},
    stateDir: join(homeDir, "state"),
    observerSocketPath: join(homeDir, "run", "observer.sock"),
    hookSpoolDir: join(homeDir, "state", "spool", "hooks"),
    stationConfigPath: join(homeDir, "station.toml"),
  };
}

async function probeWithoutWrites(options: ClaudeHarnessReadinessProviderOptions) {
  const root = options.homeDir;
  if (root === undefined) throw new Error("readiness fixture requires a temporary home");
  const before = await snapshotTree(root);
  const facts = await createClaudeHarnessReadinessProvider(options).probe();
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
