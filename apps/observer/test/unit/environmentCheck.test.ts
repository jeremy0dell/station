import type { OrphanedRuntimeState, SessionView } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildSessionEnvironmentCheck } from "../../src/diagnostics/environmentCheck";

function session(
  title: string,
  provider: string,
  state: string,
  evidence: Partial<NonNullable<SessionView["terminal"]>> = {},
): SessionView {
  // Only `title` and `terminal.{provider,state}` are read by the check.
  return { title, terminal: { provider, state, ...evidence } } as unknown as SessionView;
}

function sessionWithoutTerminal(title: string): SessionView {
  return { title } as unknown as SessionView;
}

function orphan(kind: OrphanedRuntimeState["kind"]): OrphanedRuntimeState {
  return { kind } as unknown as OrphanedRuntimeState;
}

describe("buildSessionEnvironmentCheck", () => {
  it("is ok with no sessions", () => {
    const check = buildSessionEnvironmentCheck({ sessions: [], orphans: [] });
    expect(check.name).toBe("sessions");
    expect(check.status).toBe("ok");
    expect(check.message).toBe("0 session(s).");
  });

  it("is ok when every session terminal is open, and breaks down by provider", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [session("a", "native", "open"), session("b", "native", "open")],
      orphans: [],
    });
    expect(check.status).toBe("ok");
    expect(check.message).toBe(
      "2 session(s) — native: 2 open. Terminal evidence — external focus: 0 yes, 0 no, 2 unknown · managed attachment: 0 yes, 0 no, 2 unknown.",
    );
  });

  it("reports canonical sessions that have no observed terminal", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [sessionWithoutTerminal("external")],
      orphans: [],
    });

    expect(check.status).toBe("ok");
    expect(check.message).toBe(
      "1 session(s) — no terminal: 1. Terminal evidence — external focus: 0 yes, 0 no, 1 unknown · managed attachment: 0 yes, 0 no, 1 unknown.",
    );
  });

  it("reports detached sessions without claiming they are unreachable", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [
        session("adc0a0", "native", "open", {
          focusable: false,
          hasManagedAttachment: true,
        }),
        session("b83b75", "tmux", "detached", { focusable: true }),
        session("ui-explore", "tmux", "detached", { focusable: true }),
      ],
      orphans: [],
    });
    expect(check.status).toBe("ok");
    expect(check.message).toContain("native: 1 open · tmux: 2 detached");
    expect(check.message).toContain("external focus: 2 yes, 1 no, 0 unknown");
    expect(check.message).toContain("managed attachment: 1 yes, 0 no, 2 unknown");
    expect(check.message).not.toContain("not attachable here");
  });

  it("warns and names stale terminals", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [session("x", "native", "stale")],
      orphans: [],
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("1 stale: x [native]");
  });

  it("warns on orphaned runtime states and counts them by kind", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [session("a", "native", "open")],
      orphans: [orphan("terminal_target"), orphan("session")],
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("2 orphaned runtime state(s) (1 session, 1 terminal_target).");
  });

  it("truncates the stale list past four with a +N more suffix", () => {
    const stale = ["a", "b", "c", "d", "e", "f"].map((title) => session(title, "tmux", "stale"));
    const check = buildSessionEnvironmentCheck({ sessions: stale, orphans: [] });
    expect(check.message).toContain("6 stale");
    expect(check.message).toContain("+2 more");
  });
});
