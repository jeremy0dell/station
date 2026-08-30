import type { SessionRecoveryHandle } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { selectNewestSessionRecoveryCandidate } from "../../src/sessionRecovery/selection";

const newest = "2026-08-20T12:00:00.000Z";
const older = "2026-08-20T11:00:00.000Z";

function candidate(
  id: string,
  overrides: Partial<SessionRecoveryHandle> = {},
): { handle: SessionRecoveryHandle; marker: string } {
  return {
    marker: id,
    handle: {
      id,
      provider: "fake-harness",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_feature",
      target: { kind: "native-session", id: `native_${id}` },
      cwd: "/tmp/station/web/feature",
      observedAt: older,
      lastSeenAt: older,
      ...overrides,
    },
  };
}

describe("selectNewestSessionRecoveryCandidate", () => {
  it("returns no selection for no eligible candidates", () => {
    expect(selectNewestSessionRecoveryCandidate([])).toBeUndefined();
  });

  it("selects the most recently active candidate independent of input order", () => {
    const first = candidate("rec_first");
    const selected = candidate("rec_selected", { lastSeenAt: newest });

    expect(selectNewestSessionRecoveryCandidate([first, selected])).toBe(selected);
    expect(selectNewestSessionRecoveryCandidate([selected, first])).toBe(selected);
  });

  it("uses newest observation when last activity ties", () => {
    const first = candidate("rec_first");
    const selected = candidate("rec_selected", { observedAt: newest });

    expect(selectNewestSessionRecoveryCandidate([first, selected])).toBe(selected);
    expect(selectNewestSessionRecoveryCandidate([selected, first])).toBe(selected);
  });

  it("uses opaque Station handle identity as the final stable tie-breaker", () => {
    const selected = candidate("rec_a");
    const other = candidate("rec_b");

    expect(selectNewestSessionRecoveryCandidate([other, selected])).toBe(selected);
    expect(selectNewestSessionRecoveryCandidate([selected, other])).toBe(selected);
  });
});
