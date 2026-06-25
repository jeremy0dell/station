import type { ProviderHookEvent } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { codexHookAdapter } from "../../src/hookAdapter";

const now = "2026-05-27T12:00:00.000Z";

const baseHarnessEvent: ProviderHookEvent = {
  schemaVersion: 1,
  provider: "codex",
  kind: "harness",
  event: "SessionStart",
  receivedAt: now,
};

describe("codexHookAdapter scope and enrichment", () => {
  it("fills missing STATION identity fields from env via the shared contract helper", () => {
    expect(
      codexHookAdapter.enrichPayload?.({
        payload: {
          hook_event_name: "SessionStart",
          cwd: "/tmp/station/web/task",
        },
        env: {
          STATION_SESSION_ID: "ses_web_task",
          STATION_WORKTREE_ID: "wt_web_task",
        },
      }),
    ).toMatchObject({
      station_session_id: "ses_web_task",
      station_worktree_id: "wt_web_task",
    });
  });

  it("does not overwrite identity already present in the payload", () => {
    expect(
      codexHookAdapter.enrichPayload?.({
        payload: { station_session_id: "ses_existing" },
        env: { STATION_SESSION_ID: "ses_env" },
      }),
    ).toMatchObject({ station_session_id: "ses_existing" });
  });

  it("accepts harness events carrying both session and worktree identity", () => {
    expect(
      codexHookAdapter.decideScope?.({
        ...baseHarnessEvent,
        payload: {
          station_session_id: "ses_web_task",
          station_worktree_id: "wt_web_task",
        },
      }),
    ).toEqual({ action: "accept", reason: "station-env" });
  });

  it("ignores harness events missing worktree identity", () => {
    expect(
      codexHookAdapter.decideScope?.({
        ...baseHarnessEvent,
        payload: { station_session_id: "ses_web_task" },
      }),
    ).toEqual({ action: "ignore", reason: "missing-station-env" });
  });

  it("ignores harness events whose identity fields are empty", () => {
    expect(
      codexHookAdapter.decideScope?.({
        ...baseHarnessEvent,
        payload: { station_session_id: "", station_worktree_id: "wt_web_task" },
      }),
    ).toEqual({ action: "ignore", reason: "missing-station-env" });
  });

  it("accepts non-harness events without requiring station identity", () => {
    expect(
      codexHookAdapter.decideScope?.({
        ...baseHarnessEvent,
        kind: "terminal",
        payload: {},
      }),
    ).toEqual({ action: "accept", reason: "not-required" });
  });
});
