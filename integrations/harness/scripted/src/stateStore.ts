import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessRunObservation } from "@station/contracts";
import {
  type RuntimeClock,
  runRuntimeBoundaryWithRetryAndTimeout,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { parseScriptedAgentEvent, type ScriptedAgentEvent } from "./events.js";

export type DiscoverScriptedRunsOptions = {
  stateDir: string;
  clock?: RuntimeClock;
  timeoutMs?: number;
  retries?: number;
};

export async function discoverScriptedRuns(
  options: DiscoverScriptedRunsOptions,
): Promise<HarnessRunObservation[]> {
  const clock = options.clock ?? systemClock;
  const result = await runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: "provider.scripted.discoverRuns",
      clock,
      timeoutMs: options.timeoutMs ?? 1000,
      error: {
        tag: "HarnessProviderError",
        code: "HARNESS_SCRIPTED_DISCOVER_FAILED",
        message: "The scripted harness provider failed to discover runs.",
        provider: "scripted",
      },
      retry: {
        retries: options.retries ?? 0,
        delayMs: 10,
      },
    },
    async () => readScriptedRuns(options.stateDir, clock),
  );

  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function readScriptedRuns(
  stateDir: string,
  clock: RuntimeClock,
): Promise<HarnessRunObservation[]> {
  const runsDir = join(stateDir, "runs");
  await mkdir(runsDir, { recursive: true });
  const entries = await readdir(runsDir, { withFileTypes: true });
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => eventsFromFile(join(runsDir, entry.name))),
  );
  return runs.filter((events) => events.length > 0).map((events) => runFromEvents(events, clock));
}

async function eventsFromFile(path: string): Promise<ScriptedAgentEvent[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseScriptedAgentEvent(JSON.parse(line)));
}

function runFromEvents(events: ScriptedAgentEvent[], clock: RuntimeClock): HarnessRunObservation {
  const sorted = [...events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const latest = sorted.at(-1);
  if (latest === undefined) {
    throw new Error("Cannot build a scripted run from an empty event list.");
  }
  const identity = firstIdentity(sorted);
  const pid = [...sorted]
    .reverse()
    .find((event) => event.pid !== undefined && event.type !== "exit")?.pid;

  return {
    id: latest.runId,
    provider: "scripted",
    ...(identity.projectId === undefined ? {} : { projectId: identity.projectId }),
    ...(identity.worktreeId === undefined ? {} : { worktreeId: identity.worktreeId }),
    ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
    ...(pid === undefined ? {} : { pid }),
    ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
    state: "unknown",
    confidence: "low",
    reason: "Unclassified scripted run.",
    observedAt: latest.at ?? toIsoTimestamp(clock.now()),
    providerData: {
      events: sorted,
    },
  };
}

// Identity is sticky for a run: use the first non-empty value so later activity cannot drift it.
function firstIdentity(events: ScriptedAgentEvent[]): {
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  cwd?: string;
} {
  const result: {
    projectId?: string;
    worktreeId?: string;
    sessionId?: string;
    cwd?: string;
  } = {};
  for (const event of events) {
    if (result.projectId === undefined && event.projectId !== undefined) {
      result.projectId = event.projectId;
    }
    if (result.worktreeId === undefined && event.worktreeId !== undefined) {
      result.worktreeId = event.worktreeId;
    }
    if (result.sessionId === undefined && event.sessionId !== undefined) {
      result.sessionId = event.sessionId;
    }
    if (result.cwd === undefined && event.cwd !== undefined) {
      result.cwd = event.cwd;
    }
  }
  return result;
}
