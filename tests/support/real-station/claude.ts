import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RealE2eEnvironment } from "./env";
import { runStationJson } from "./process";
import type { RealTempRepo } from "./repo";

export type ClaudeSentinel = {
  relativePath: string;
  absolutePath: string;
  token: string;
  prompt: string;
};

export type ClaudeHookFixture = {
  settingsPath: string;
  hookScriptPath: string;
};

export function createClaudeSentinel(repo: RealTempRepo, label: string): ClaudeSentinel {
  const token = `station-real-${label}-${process.pid}-${Date.now()}`;
  const relativePath = `.station-real-e2e/sentinels/${sanitize(label)}-${Date.now()}.txt`;
  const absolutePath = join(repo.repoPath, relativePath);
  return {
    relativePath,
    absolutePath,
    token,
    prompt: boundedClaudePrompt(relativePath, token),
  };
}

export async function waitForClaudeSentinel(
  sentinel: ClaudeSentinel,
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
  throw new Error(`Claude did not write sentinel ${sentinel.relativePath}.`);
}

export async function installClaudeHookProjectConfig(input: {
  env: RealE2eEnvironment;
  repo: RealTempRepo;
  configPath: string;
}): Promise<ClaudeHookFixture> {
  // The settings artifact and hook script resolve under the fixture's state dir
  // (from the station config); only the ingress binary needs an explicit override.
  const result = await runStationJson<{ settingsPath: string; hookScriptPath: string }>(input.env, {
    configPath: input.configPath,
    args: ["hooks", "install", "claude", "--yes", "--hook-bin", input.env.stationIngressBin],
    timeoutMs: 30_000,
  });
  return {
    settingsPath: result.settingsPath,
    hookScriptPath: result.hookScriptPath,
  };
}

function boundedClaudePrompt(relativePath: string, token: string): string {
  return [
    "This is a station real E2E sentinel task.",
    `Create or overwrite only ${relativePath}.`,
    `Write exactly this token followed by a newline: ${token}`,
    "Do not modify any other files.",
  ].join("\n");
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
