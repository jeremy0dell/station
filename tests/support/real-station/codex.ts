import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  hookLogDirPath: string;
  hookPayloadLogPath: string;
  hookDeliveryLogPath: string;
  cleanup: () => Promise<void>;
};

export function createCodexSentinel(repo: RealTempRepo, label: string): CodexSentinel {
  const token = `station-real-${label}-${process.pid}-${Date.now()}`;
  const relativePath = `.station-real-e2e/sentinels/${sanitize(label)}-${Date.now()}.txt`;
  const absolutePath = join(repo.repoPath, relativePath);
  return {
    relativePath,
    absolutePath,
    token,
    prompt: boundedCodexPrompt(relativePath, token),
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

export async function createCodexHookEnabledWrapper(input: {
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

export async function installCodexHookProjectConfig(input: {
  env: RealE2eEnvironment;
  repo: RealTempRepo;
  configPath: string;
}): Promise<CodexHookFixture> {
  const codexHome = codexHomeForRepo(input.repo);
  const hookConfigPath = join(codexHome, "station.config.toml");
  const hookLogDirPath = join(
    tmpdir(),
    `station-real-codex-hooks-${process.pid}-${Date.now()}-${basename(input.repo.root)}`,
  );
  const hookScriptPath = join(hookLogDirPath, "station-codex-hook.sh");
  const hookPayloadLogPath = join(hookLogDirPath, "codex-hook-payloads.jsonl");
  const hookDeliveryLogPath = join(hookLogDirPath, "codex-hook-delivery.log");
  await mkdir(hookLogDirPath, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await runStationJson(input.env, {
    configPath: input.configPath,
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
    hookLogDirPath,
    hookPayloadLogPath,
    hookDeliveryLogPath,
    cleanup: async () => {
      await rm(hookLogDirPath, { recursive: true, force: true });
    },
  };
}

export async function waitForFileContaining(
  filePath: string,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    if (content.includes(text)) {
      return;
    }
    await delay(500);
  }
  throw new Error(`${filePath} did not contain ${text}.`);
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
