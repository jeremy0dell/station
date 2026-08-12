import { createFakeTerminalTarget, createFakeWorktree } from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  eventFromRow,
  providerObservationFromRow,
  type SqliteEventRow,
  type SqliteProviderObservationRow,
} from "../../src/persistence/rows";

const now = "2026-05-21T12:00:00.000Z";

describe("persistence row conversion", () => {
  it("parses the entity kind and payload together through the matching strict schema", () => {
    const worktree = createFakeWorktree({ now });

    expect(
      providerObservationFromRow(providerObservationRow("worktree", worktree), now),
    ).toMatchObject({
      entityKind: "worktree",
      payload: worktree,
    });
    expect(() =>
      providerObservationFromRow(
        providerObservationRow("worktree", { ...worktree, state: "archived" }),
        now,
      ),
    ).toThrow();
    expect(() =>
      providerObservationFromRow(providerObservationRow("retired_kind", worktree), now),
    ).toThrow();
  });

  it("strictly parses health observations", () => {
    expect(
      providerObservationFromRow(
        providerObservationRow("provider_health", {
          providerId: "fake-harness",
          providerType: "harness",
          status: "healthy",
          lastCheckedAt: now,
        }),
        now,
      ),
    ).toMatchObject({
      entityKind: "provider_health",
      payload: { providerId: "fake-harness", status: "healthy" },
    });
    expect(() =>
      providerObservationFromRow(
        providerObservationRow("provider_health", { status: "healthy" }),
        now,
      ),
    ).toThrow();
  });

  it("strips terminal provider data after strict parsing", () => {
    const terminal = createFakeTerminalTarget({
      now,
      providerData: { socketPath: "/tmp/private.sock" },
    });

    const observation = providerObservationFromRow(
      providerObservationRow("terminal_target", terminal),
      now,
    );

    expect(observation.entityKind).toBe("terminal_target");
    if (observation.entityKind === "terminal_target") {
      expect(observation.payload.providerData).toBeUndefined();
    }
  });

  it("rejects event rows whose indexed metadata contradicts the strict payload", () => {
    const row: SqliteEventRow = {
      id: "evt_1",
      type: "command.succeeded",
      source: "observer",
      command_id: "cmd_1",
      trace_id: null,
      span_id: null,
      payload_json: JSON.stringify({ type: "command.succeeded", commandId: "cmd_1" }),
      created_at: now,
    };

    expect(eventFromRow(row)).toMatchObject({ type: "command.succeeded", commandId: "cmd_1" });
    expect(() => eventFromRow({ ...row, type: "command.failed" })).toThrow(
      "metadata does not match",
    );
    expect(() => eventFromRow({ ...row, command_id: "cmd_other" })).toThrow(
      "metadata does not match",
    );
  });
});

function providerObservationRow(
  entityKind: string,
  payload: unknown,
): SqliteProviderObservationRow {
  return {
    id: "obs_1",
    provider: "fake-provider",
    provider_type: "observer",
    entity_kind: entityKind,
    entity_key: "fake-provider",
    payload_json: JSON.stringify(payload),
    observed_at: now,
    expires_at: null,
  };
}
