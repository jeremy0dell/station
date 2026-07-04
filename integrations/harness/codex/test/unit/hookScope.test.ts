import type { ProviderHookEvent } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { codexHookAdapter } from "../../src/hookAdapter";

const receivedAt = "2026-05-21T12:00:00.000Z";

function hookEvent(payload: unknown): ProviderHookEvent {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    provider: "codex",
    kind: "harness",
    event: "PreToolUse",
    receivedAt,
    payload,
  };
}

describe("codex hook scope decision", () => {
  it("accepts station-launched sessions by env identity", () => {
    const decision = codexHookAdapter.decideScope?.(
      hookEvent({
        cwd: "/repo/wt",
        station_session_id: "ses_web_task",
        station_worktree_id: "wt_web_task",
      }),
    );
    expect(decision).toEqual({ action: "accept", reason: "station-env" });
  });

  it("accepts external sessions by payload cwd", () => {
    const decision = codexHookAdapter.decideScope?.(hookEvent({ cwd: "/repo/wt" }));
    expect(decision).toEqual({ action: "accept", reason: "cwd" });
  });

  it("ignores payloads with neither station env nor cwd", () => {
    const decision = codexHookAdapter.decideScope?.(hookEvent({ session_id: "abc" }));
    expect(decision).toEqual({ action: "ignore", reason: "missing-station-env" });
  });
});
