import { describe, expect, it } from "vitest";
import {
  harnessRunFromRow,
  type SqliteHarnessRunRow,
  type SqliteTerminalTargetRow,
  type SqliteWorktreeRow,
  terminalTargetFromRow,
  worktreeFromRow,
} from "../../src/persistence/rows";

const lastSeenAt = "2026-05-21T12:00:00.000Z";

describe("persistence row conversion", () => {
  it("parses persisted enum-like fields through contract schemas", () => {
    expect(worktreeFromRow(worktreeRow({ source: "worktrunk", state: "exists" }))).toMatchObject({
      source: "worktrunk",
      state: "exists",
    });
    expect(terminalTargetFromRow(terminalTargetRow({ state: "detached" }))).toMatchObject({
      state: "detached",
    });
    expect(
      harnessRunFromRow(harnessRunRow({ state: "working", confidence: "medium" })),
    ).toMatchObject({
      state: "working",
      confidence: "medium",
    });
  });

  it("rejects stale persisted enum strings instead of widening them to plain string", () => {
    expect(() => worktreeFromRow(worktreeRow({ state: "archived" }))).toThrow();
    expect(() => terminalTargetFromRow(terminalTargetRow({ state: "busy" }))).toThrow();
    expect(() => harnessRunFromRow(harnessRunRow({ confidence: "certain" }))).toThrow();
  });
});

function worktreeRow(overrides: Partial<SqliteWorktreeRow> = {}): SqliteWorktreeRow {
  return {
    id: "wt_web_main",
    project_id: "web",
    path: "/tmp/station/web",
    branch: "main",
    source: null,
    state: null,
    dirty: null,
    provider: null,
    provider_data_json: null,
    last_seen_at: lastSeenAt,
    ...overrides,
  };
}

function terminalTargetRow(
  overrides: Partial<SqliteTerminalTargetRow> = {},
): SqliteTerminalTargetRow {
  return {
    id: "term_web_main",
    session_id: null,
    project_id: null,
    worktree_id: null,
    provider: "tmux",
    state: null,
    provider_key: null,
    provider_data_json: null,
    last_seen_at: lastSeenAt,
    ...overrides,
  };
}

function harnessRunRow(overrides: Partial<SqliteHarnessRunRow> = {}): SqliteHarnessRunRow {
  return {
    id: "run_web_main",
    session_id: null,
    project_id: null,
    worktree_id: null,
    harness: "scripted",
    pid: null,
    external_run_id: null,
    state: null,
    confidence: null,
    reason: null,
    provider_data_json: null,
    last_event_at: null,
    last_seen_at: lastSeenAt,
    ...overrides,
  };
}
