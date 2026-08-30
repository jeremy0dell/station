import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClaudeHookEventSchema } from "@station/claude";
import type { StationSnapshot } from "@station/contracts";
import { buildWorkbenchWindowName } from "@station/tmux";
import type { RealE2eEnvironment } from "./env";
import { runStationJson } from "./process";
import {
  type IngressAttempt,
  type ProviderSessionStartWitness,
  pathsReferToSameLocation,
  type RealIngressWitness,
} from "./recovery";
import type { RealTempRepo } from "./repo";
import { activeTmuxPane, captureTmuxPane, type RealTmuxEndpoint, sendTmuxKeys } from "./tmux";

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

export type ClaudeSessionStartWitness = ProviderSessionStartWitness & {
  provider: "claude";
  target: { kind: "native-session"; id: string };
  mode: "interactive";
  source: string;
  settingsArtifact: string;
  hooks: ClaudeHookFixture;
  delivery: {
    attemptId: string;
    invokedAt: string;
    argv: string[];
    exitStatus: 0;
    stdout: string;
    stderr: string;
  };
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

export async function readClaudeSessionStartWitness(input: {
  ingress: Pick<RealIngressWitness, "readAttempts">;
  hooks: ClaudeHookFixture;
  cwd?: string;
  source?: string;
  invokedAfter?: string;
  nativeSessionId?: string;
}): Promise<ClaudeSessionStartWitness | undefined> {
  const attempts = await input.ingress.readAttempts();
  return claudeSessionStartWitnessFromAttempts(attempts, input);
}

export function claudeSessionStartWitnessFromAttempts(
  attempts: readonly IngressAttempt[],
  input: {
    hooks: ClaudeHookFixture;
    cwd?: string;
    source?: string;
    invokedAfter?: string;
    nativeSessionId?: string;
  },
): ClaudeSessionStartWitness | undefined {
  for (const attempt of attempts) {
    if (input.invokedAfter !== undefined && attempt.invokedAt <= input.invokedAfter) continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(attempt.rawInput);
    } catch {
      continue;
    }
    const parsed = ClaudeHookEventSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.hook_event_name !== "SessionStart") continue;
    const event = parsed.data;
    if (input.cwd !== undefined && !pathsReferToSameLocation(event.cwd, input.cwd)) continue;
    if (input.source !== undefined && event.source !== input.source) continue;
    if (input.nativeSessionId !== undefined && event.session_id !== input.nativeSessionId) continue;
    if (attempt.exitStatus !== 0) continue;
    return {
      provider: "claude",
      target: { kind: "native-session", id: event.session_id },
      cwd: event.cwd,
      attempt,
      mode: "interactive",
      source: event.source,
      settingsArtifact: input.hooks.settingsPath,
      hooks: input.hooks,
      delivery: {
        attemptId: attempt.id,
        invokedAt: attempt.invokedAt,
        argv: attempt.argv,
        exitStatus: 0,
        stdout: attempt.stdout,
        stderr: attempt.stderr,
      },
    };
  }
  return undefined;
}

export async function continuePastClaudeTrustDialog(
  endpoint: RealTmuxEndpoint,
  tmuxSession: string,
  row: StationSnapshot["rows"][number],
): Promise<void> {
  const target = await activeTmuxPane(
    endpoint,
    `${tmuxSession}:${buildWorkbenchWindowName({
      projectId: row.projectId,
      branch: row.branch,
      worktreeId: row.id,
      path: row.path,
    })}.0`,
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const captured = await captureTmuxPane({ endpoint, target });
    if (captured.includes("Yes, I trust this folder")) {
      await sendTmuxKeys({ endpoint, target, keys: ["Enter"] });
      return;
    }
    await delay(500);
  }
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
