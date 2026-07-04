import type { ProviderHookEvent } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { claudeHookAdapter } from "../../src/hookAdapter";

const receivedAt = "2026-05-21T12:00:00.000Z";

function hookEvent(payload: unknown, event = "PreToolUse"): ProviderHookEvent {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    provider: "claude",
    kind: "harness",
    event,
    receivedAt,
    payload,
  };
}

describe("claude hook scope decision", () => {
  it("accepts station-launched sessions by env identity", () => {
    const decision = claudeHookAdapter.decideScope?.(
      hookEvent({
        cwd: "/repo/wt",
        station_session_id: "ses_web_task",
        station_worktree_id: "wt_web_task",
      }),
    );
    expect(decision).toEqual({ action: "accept", reason: "station-env" });
  });

  it("accepts external sessions by payload cwd", () => {
    const decision = claudeHookAdapter.decideScope?.(hookEvent({ cwd: "/repo/wt" }));
    expect(decision).toEqual({ action: "accept", reason: "cwd" });
  });

  it("ignores payloads with neither station env nor cwd", () => {
    const decision = claudeHookAdapter.decideScope?.(hookEvent({ session_id: "abc" }));
    expect(decision).toEqual({ action: "ignore", reason: "missing-station-env" });
  });

  it("ignores unlisted event types before any identity check", () => {
    const decision = claudeHookAdapter.decideScope?.(
      hookEvent({ cwd: "/repo/wt" }, "SomeUserAddedHook"),
    );
    expect(decision).toEqual({ action: "ignore", reason: "event-not-forwarded" });
  });
});
