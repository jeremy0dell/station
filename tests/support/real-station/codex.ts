import { access, chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RealStationConfigFixture } from "./config";
import type { RealE2eEnvironment } from "./env";
import { requireToolPath } from "./env";
import { runStationJson } from "./process";
import type { RealTempRepo } from "./repo";

export type CodexSentinel = {
  relativePath: string;
  absolutePath: string;
  token: string;
  prompt: string;
};

export type CodexBranchSwitchSentinel = CodexSentinel & {
  branch: string;
};

export type CodexHookFixture = {
  hookScriptPath: string;
  hookConfigPath: string;
};

export type RealCodexFixture = {
  env: RealE2eEnvironment;
  codexHome: string;
  codexCommand: string;
  installHooks: (config: RealStationConfigFixture) => Promise<CodexHookFixture>;
};

export async function createRealCodexFixture(input: {
  env: RealE2eEnvironment;
  repo: RealTempRepo;
}): Promise<RealCodexFixture> {
  const codexHome = codexHomeForRepo(input.repo);
  const codexCommand = await createCodexHookEnabledWrapper(input);
  const stationWrapperPath = join(input.repo.root, "stn-with-private-codex-home.sh");
  await writeFile(
    stationWrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export CODEX_HOME=${shellSingleQuote(codexHome)}`,
      `exec ${shellSingleQuote(input.env.stationBin)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(stationWrapperPath, 0o700);
  const env: RealE2eEnvironment = { ...input.env, stationBin: stationWrapperPath };
  return {
    env,
    codexHome,
    codexCommand,
    installHooks: (config) => installCodexHookProjectConfig({ env, repo: input.repo, config }),
  };
}

export function createCodexSentinel(
  repo: RealTempRepo,
  label: string,
  targetRoot?: string,
): CodexSentinel {
  const token = `station-real-${label}-${process.pid}-${Date.now()}`;
  const relativePath = `.station-real-e2e/sentinels/${sanitize(label)}-${Date.now()}.txt`;
  const absolutePath = join(targetRoot ?? repo.repoPath, relativePath);
  return {
    relativePath,
    absolutePath,
    token,
    prompt: boundedCodexPrompt(targetRoot === undefined ? relativePath : absolutePath, token),
  };
}

export function createCodexBranchSwitchSentinel(
  repo: RealTempRepo,
  label: string,
  branch: string,
): CodexBranchSwitchSentinel {
  const token = `station-real-${label}-${process.pid}-${Date.now()}`;
  const relativePath = `.station-real-e2e/sentinels/${sanitize(label)}-${Date.now()}.txt`;
  const absolutePath = join(repo.repoPath, relativePath);
  return {
    relativePath,
    absolutePath,
    token,
    branch,
    prompt: boundedCodexBranchSwitchPrompt(relativePath, token, branch),
  };
}

export async function waitForCodexSentinel(
  sentinel: CodexSentinel,
  options: number | { rootPath?: string; timeoutMs?: number } = 180_000,
): Promise<void> {
  const timeoutMs = typeof options === "number" ? options : (options.timeoutMs ?? 180_000);
  const absolutePath =
    typeof options === "number" || options.rootPath === undefined
      ? sentinel.absolutePath
      : join(options.rootPath, sentinel.relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const text = await readFile(absolutePath, "utf8").catch(() => "");
    if (text.includes(sentinel.token)) {
      return;
    }
    await delay(1000);
  }
  throw new Error(`Codex did not write sentinel ${sentinel.relativePath}.`);
}

async function createCodexHookEnabledWrapper(input: {
  env: RealE2eEnvironment;
  repo: RealTempRepo;
}): Promise<string> {
  const wrapperPath = join(input.repo.root, "codex-with-station-hooks.sh");
  const codexHome = codexHomeForRepo(input.repo);
  const codexBin = requireToolPath(input.env, "codex");
  await mkdir(codexHome, { recursive: true });
  await linkCodexUserFile(codexHome, "auth.json");
  await ensureCodexConfigFile(codexHome);
  await writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export CODEX_HOME=${shellSingleQuote(codexHome)}`,
      `if [ "\${1-}" = "login" ]; then`,
      `  exec ${shellSingleQuote(codexBin)} "$@"`,
      "fi",
      `exec ${shellSingleQuote(codexBin)} '--dangerously-bypass-hook-trust' "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o700);
  return wrapperPath;
}

async function installCodexHookProjectConfig(input: {
  env: RealE2eEnvironment;
  repo: RealTempRepo;
  config: RealStationConfigFixture;
}): Promise<CodexHookFixture> {
  const codexHome = codexHomeForRepo(input.repo);
  const hookConfigPath = join(codexHome, "station.config.toml");
  const hookDirPath = join(input.config.stateDir, "hooks");
  const hookScriptPath = join(hookDirPath, "station-codex-hook.sh");
  await mkdir(hookDirPath, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await runStationJson(input.env, {
    configPath: input.config.configPath,
    args: [
      "hooks",
      "install",
      "codex",
      "--yes",
      "--codex-config",
      hookConfigPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      input.env.stationIngressBin,
    ],
    env: {
      CODEX_HOME: codexHome,
    },
    timeoutMs: 30_000,
  });
  return {
    hookScriptPath,
    hookConfigPath,
  };
}

export async function writeFailureBundle(input: {
  env: RealE2eEnvironment;
  configPath: string;
  commandId?: string;
}): Promise<unknown | undefined> {
  const args = ["debug", "bundle"];
  if (input.commandId !== undefined) {
    args.push("--command", input.commandId);
  }
  return runStationJson(input.env, {
    configPath: input.configPath,
    args,
    timeoutMs: 30_000,
  }).catch(() => undefined);
}

function boundedCodexPrompt(relativePath: string, token: string): string {
  return [
    "This is a station real E2E sentinel task.",
    `Create or overwrite only ${relativePath}.`,
    `Write exactly this token followed by a newline: ${token}`,
    "Do not modify any other files.",
  ].join("\n");
}

function boundedCodexBranchSwitchPrompt(
  relativePath: string,
  token: string,
  branch: string,
): string {
  return [
    "This is a station real E2E branch-switch sentinel task.",
    `Create and switch to a new Git branch named ${branch}.`,
    `Then create or overwrite only ${relativePath}.`,
    `Write exactly this token followed by a newline: ${token}`,
    "Do not modify any other files.",
  ].join("\n");
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function codexHomeForRepo(repo: RealTempRepo): string {
  return join(repo.root, "codex-home");
}

async function linkCodexUserFile(codexHome: string, fileName: string): Promise<void> {
  const source = join(homedir(), ".codex", fileName);
  try {
    await access(source);
  } catch {
    return;
  }
  try {
    await symlink(source, join(codexHome, fileName));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

async function ensureCodexConfigFile(codexHome: string): Promise<void> {
  await writeFile(join(codexHome, "config.toml"), "[features]\nhooks = true\n", "utf8");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
