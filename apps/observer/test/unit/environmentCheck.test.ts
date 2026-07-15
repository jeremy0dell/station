import type { OrphanedRuntimeState, SessionView } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildSessionEnvironmentCheck } from "../../src/diagnostics/environmentCheck";

function session(title: string, provider: string, state: string): SessionView {
  // Only `title` and `terminal.{provider,state}` are read by the check.
  return { title, terminal: { provider, state } } as unknown as SessionView;
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
    expect(check.message).toBe("2 session(s) — native: 2 open.");
  });

  it("reports canonical sessions that have no observed terminal", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [sessionWithoutTerminal("external")],
      orphans: [],
    });

    expect(check.status).toBe("ok");
    expect(check.message).toBe("1 session(s) — no terminal: 1.");
  });

  it("warns and names detached sessions with their provider (the silent-click case)", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [
        session("adc0a0", "native", "open"),
        session("b83b75", "tmux", "detached"),
        session("ui-explore", "tmux", "detached"),
      ],
      orphans: [],
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("native: 1 open · tmux: 2 detached");
    expect(check.message).toContain("2 detached/stale (running, not attachable here):");
    expect(check.message).toContain("b83b75 [tmux]");
    expect(check.message).toContain("ui-explore [tmux]");
  });

  it("treats stale terminals as detached/stale too", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [session("x", "native", "stale")],
      orphans: [],
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("1 detached/stale");
  });

  it("warns on orphaned runtime states and counts them by kind", () => {
    const check = buildSessionEnvironmentCheck({
      sessions: [session("a", "native", "open")],
      orphans: [orphan("terminal_target"), orphan("session")],
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("2 orphaned runtime state(s) (1 session, 1 terminal_target).");
  });

  it("truncates the detached list past four with a +N more suffix", () => {
    const detached = ["a", "b", "c", "d", "e", "f"].map((t) => session(t, "tmux", "detached"));
    const check = buildSessionEnvironmentCheck({ sessions: detached, orphans: [] });
    expect(check.message).toContain("6 detached/stale");
    expect(check.message).toContain("+2 more");
  });
});
