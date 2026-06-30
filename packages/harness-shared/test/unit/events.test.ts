import type { HarnessEventContext, StationHookIdentityPayload } from "@station/contracts";
import { createFakeTerminalTarget, createFakeWorktree } from "@station/testing";
import { describe, expect, it } from "vitest";
import { correlateTerminalBoundHarnessEvent } from "../../src/events";

const NOW = "2026-06-11T12:00:00.000Z";

function contextWithTerminal(present: boolean): HarnessEventContext {
  return {
    projects: [],
    worktrees: [
      createFakeWorktree({
        id: "wt_web_task",
        projectId: "web",
        path: "/tmp/station/web/task",
        now: NOW,
      }),
    ],
    terminalTargets: present
      ? [
          createFakeTerminalTarget({
            id: "term_main",
            projectId: "web",
            worktreeId: "wt_web_task",
            cwd: "/tmp/station/web/task",
            now: NOW,
          }),
        ]
      : [],
  };
}

describe("correlateTerminalBoundHarnessEvent harnessRunId derivation", () => {
  // claude/codex semantics: do NOT pass includeTerminalTargetId.
  it("derives harnessRunId from a matched terminal, not the raw target id", () => {
    const identity: StationHookIdentityPayload = { station_terminal_target_id: "term_main" };
    const result = correlateTerminalBoundHarnessEvent({
      provider: "codex",
      identity,
      context: contextWithTerminal(true),
    });
    expect(result.harnessRunId).toBe("codex:term_main");
    expect(result.terminalTargetId).toBeUndefined();
  });

  // The F2 regression guard: a raw target id that resolves to no terminal must NOT become the run id.
  it("leaves harnessRunId unset when the raw target id resolves to no terminal", () => {
    const identity: StationHookIdentityPayload = { station_terminal_target_id: "term_ghost" };
    const result = correlateTerminalBoundHarnessEvent({
      provider: "codex",
      identity,
      context: contextWithTerminal(false),
    });
    expect(result.harnessRunId).toBeUndefined();
    expect(result.terminalTargetId).toBeUndefined();
  });

  // cursor/opencode/pi semantics: opt in via includeTerminalTargetId to trust the raw target id.
  it("derives harnessRunId directly from the raw target id when opting in", () => {
    const identity: StationHookIdentityPayload = { station_terminal_target_id: "term_ghost" };
    const result = correlateTerminalBoundHarnessEvent({
      provider: "cursor",
      identity,
      context: contextWithTerminal(false),
      includeTerminalTargetId: true,
    });
    expect(result.harnessRunId).toBe("cursor:term_ghost");
    expect(result.terminalTargetId).toBe("term_ghost");
  });
});
