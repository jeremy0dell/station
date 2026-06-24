import type { TerminalTargetObservation, WorktreeObservation } from "@station/contracts";
import { discoverTerminalBoundHarnessRuns, HarnessRunObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-05-21T12:00:00.000Z";
const worktree: WorktreeObservation = {
  id: "wt_web_task",
  provider: "worktrunk",
  projectId: "web",
  branch: "task",
  path: "/tmp/station/web/task",
  state: "exists",
  source: "worktrunk",
  confidence: "high",
  reason: "Fixture worktree.",
  observedAt: now,
};

describe("discoverTerminalBoundHarnessRuns", () => {
  for (const provider of [
    { id: "codex", displayName: "Codex" },
    { id: "opencode", displayName: "OpenCode" },
    { id: "pi", displayName: "Pi" },
    { id: "cursor", displayName: "Cursor" },
  ]) {
    it(`turns ${provider.id} terminal bindings into normalized harness runs`, () => {
      const runs = discoverTerminalBoundHarnessRuns(
        {
          projects: [],
          worktrees: [worktree],
          terminalTargets: [
            target({
              harnessProvider: provider.id,
              currentCommand: `${provider.id}-agent`,
            }),
          ],
        },
        {
          harnessProvider: provider.id,
          displayName: provider.displayName,
          role: "main-agent",
        },
      );

      expect(runs).toHaveLength(1);
      expect(HarnessRunObservationSchema.parse(runs[0])).toEqual(runs[0]);
      expect(runs[0]).toMatchObject({
        id: `${provider.id}:tmux:station:@1:%2`,
        provider: provider.id,
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        pid: 1234,
        cwd: "/tmp/station/web/task",
        state: "unknown",
        confidence: "low",
        reason: `terminal target is bound to ${provider.displayName}; no reliable lifecycle signal yet.`,
        providerData: {
          terminalTargetId: "tmux:station:@1:%2",
          terminalProvider: "tmux",
          process: {
            command: `${provider.id}-agent`,
          },
        },
      });
    });
  }

  it("ignores mismatched harness providers and roles", () => {
    expect(
      discoverTerminalBoundHarnessRuns(
        {
          projects: [],
          worktrees: [worktree],
          terminalTargets: [target({ harnessProvider: "scripted" })],
        },
        { harnessProvider: "codex", displayName: "Codex", role: "main-agent" },
      ),
    ).toEqual([]);

    expect(
      discoverTerminalBoundHarnessRuns(
        {
          projects: [],
          worktrees: [worktree],
          terminalTargets: [target({ role: "sidecar", harnessProvider: "codex" })],
        },
        { harnessProvider: "codex", displayName: "Codex", role: "main-agent" },
      ),
    ).toEqual([]);
  });

  it("ignores definitely-shell commands and terminal targets outside the configured worktree", () => {
    const runs = discoverTerminalBoundHarnessRuns(
      {
        projects: [],
        worktrees: [worktree],
        terminalTargets: [
          target({
            id: "tmux:station:@1:%2",
            harnessProvider: "codex",
            currentCommand: "zsh",
          }),
          target({
            id: "tmux:station:@1:%3",
            harnessProvider: "codex",
            currentCommand: "codex",
            cwd: "/tmp/station/web",
          }),
        ],
      },
      { harnessProvider: "codex", displayName: "Codex", role: "main-agent" },
    );

    expect(runs).toEqual([]);
  });
});

function target(
  input: {
    id?: string;
    role?: string;
    harnessProvider: string;
    currentCommand?: string;
    cwd?: string;
  } = { harnessProvider: "codex" },
): TerminalTargetObservation {
  return {
    id: input.id ?? "tmux:station:@1:%2",
    provider: "tmux",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    state: "open",
    cwd: input.cwd ?? "/tmp/station/web/task",
    pid: 1234,
    confidence: "high",
    reason: "tmux pane has station identity binding.",
    observedAt: now,
    harnessBinding: {
      role: input.role ?? "main-agent",
      harnessProvider: input.harnessProvider,
      worktreePath: "/tmp/station/web/task",
      ...(input.currentCommand === undefined ? {} : { currentCommand: input.currentCommand }),
    },
    providerData: {
      sessionName: "station",
      windowId: "@1",
      paneId: "%2",
      attached: true,
      dead: false,
    },
  };
}
