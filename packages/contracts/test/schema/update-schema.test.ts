import {
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandStepSchema,
  UpdateSuccessorRequestSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

describe("update command schemas", () => {
  it("parses current command vocabulary strictly", () => {
    expect(UpdateChannelIdSchema.safeParse("unknown").success).toBe(false);
    expect(UpdateCommandArgvSchema.safeParse([""]).success).toBe(false);
    expect(UpdateCommandArgvSchema.parse(["stn", "update"])).toEqual(["stn", "update"]);
    expect(
      UpdateCommandStepSchema.safeParse({
        id: "plan",
        status: "completed",
        detail: "Resolved builds.",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("keeps the hidden successor request bounded to policy data", () => {
    const request = {
      schemaVersion: 1,
      channel: "installer-binary" as const,
      target: { version: "1.2.3" },
      installedScopeDigest: "a".repeat(64),
      handoff: { action: "leave-in-place" as const },
      hookProviderIds: ["codex" as const],
    };
    expect(UpdateSuccessorRequestSchema.parse(request)).toEqual(request);
    expect(
      UpdateSuccessorRequestSchema.safeParse({ ...request, executable: "/tmp/stn" }).success,
    ).toBe(false);
    expect(
      UpdateSuccessorRequestSchema.safeParse({
        ...request,
        target: { version: "1.2.3", revision: undefined },
      }).success,
    ).toBe(false);
    expect(
      UpdateSuccessorRequestSchema.safeParse({
        ...request,
        hookProviderIds: ["codex", "codex"],
      }).success,
    ).toBe(false);
    expect(
      UpdateSuccessorRequestSchema.parse({
        ...request,
        reapContinuation: { journalId: "00000000-0000-4000-8000-000000000001" },
      }),
    ).toEqual({
      ...request,
      reapContinuation: { journalId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(
      UpdateSuccessorRequestSchema.safeParse({
        ...request,
        reapContinuation: { journalId: "not-a-journal", pid: 1 },
      }).success,
    ).toBe(false);
  });
});
