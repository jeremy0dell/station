import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { ScriptedAgentHarnessProvider } from "@station/scripted-harness";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createObserverCore, ProviderRegistry } from "../../src/internal";

const now = "2026-05-20T12:00:00.000Z";

describe("observer reconcile with scripted harness", () => {
  it("classifies scripted harness runs across starting, working, and exited observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-observer-scripted-"));
    const stateDir = join(root, "scripted");
    const runsDir = join(stateDir, "runs");
    await mkdir(runsDir, { recursive: true });
    const runPath = join(runsDir, "run_web_task.jsonl");

    const provider = new ScriptedAgentHarnessProvider({
      stateDir,
      now: () => new Date("2026-05-20T12:00:10.000Z"),
    });
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({
          now,
          worktrees: [
            createFakeWorktree({
              id: "wt_web_task",
              projectId: "web",
              branch: "task",
              path: join(root, "worktree"),
              now,
            }),
          ],
        }),
        terminal: new FakeTerminalProvider({
          now,
          targets: [
            createFakeTerminalTarget({
              id: "term_web_task",
              projectId: "web",
              worktreeId: "wt_web_task",
              sessionId: "ses_web_task",
              harnessRunId: "run_web_task",
              now,
            }),
          ],
        }),
        harnesses: [provider],
      }),
      clock: {
        now: () => new Date("2026-05-20T12:00:10.000Z"),
      },
    });

    await writeEvents(runPath, [
      {
        type: "started",
        at: "2026-05-20T12:00:00.000Z",
        runId: "run_web_task",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        pid: 1234,
      },
    ]);
    expect((await core.reconcile("scripted-started")).rows[0]?.agent).toMatchObject({
      state: "starting",
      confidence: "high",
    });

    await writeEvents(runPath, [
      {
        type: "activity",
        at: "2026-05-20T12:00:08.000Z",
        runId: "run_web_task",
        message: "Editing task.txt.",
      },
    ]);
    expect((await core.reconcile("scripted-working")).rows[0]?.agent).toMatchObject({
      state: "working",
      confidence: "medium",
      reason: "Editing task.txt.",
    });

    await writeEvents(runPath, [
      {
        type: "exit",
        at: "2026-05-20T12:00:09.000Z",
        runId: "run_web_task",
        exitCode: 0,
      },
    ]);
    expect((await core.reconcile("scripted-exited")).rows[0]?.agent).toMatchObject({
      state: "exited",
      confidence: "high",
      reason: "Scripted agent exited with code 0.",
    });
  });

  it("degrades harness provider health when classification fails", async () => {
    const core = createObserverCore({
      config,
      providerTimeoutMs: 20,
      providerReadRetries: 0,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({
          now,
          worktrees: [createFakeWorktree({ id: "wt_web_task", projectId: "web", now })],
        }),
        terminal: new FakeTerminalProvider({ now }),
        harnesses: [
          new FakeHarnessProvider({
            now,
            runs: [
              createFakeHarnessRun({
                id: "run_web_task",
                projectId: "web",
                worktreeId: "wt_web_task",
                state: "working",
                now,
              }),
            ],
            failures: {
              classifyRun: {
                tag: "HarnessProviderError",
                code: "HARNESS_CLASSIFY_FAILED",
                message: "The fake harness could not classify the run.",
                provider: "fake-harness",
              },
            },
          }),
        ],
      }),
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("classify-failure");

    expect(snapshot.providerHealth["fake-harness"]).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "HARNESS_CLASSIFY_FAILED",
      },
    });
    expect(snapshot.rows[0]?.agent).toBeUndefined();
  });
});

async function writeEvents(
  path: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "scripted",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "scripted",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};
