import { describe, expect, it } from "bun:test";
import { isStationAttentionEvent } from "./attentionEvents.js";

const agent = {
  harness: "codex",
  state: "needs_attention",
  confidence: "high",
  reason: "Codex requested user input.",
  updatedAt: "2026-07-02T00:00:00.000Z",
} as const;

describe("isStationAttentionEvent", () => {
  it("matches needs_attention events carrying a typed attention kind", () => {
    expect(
      isStationAttentionEvent({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
        agent: { ...agent, attention: "question" },
      }),
    ).toBe(true);
  });

  it("matches needs_attention events without a typed attention kind", () => {
    expect(
      isStationAttentionEvent({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
        agent,
      }),
    ).toBe(true);
  });

  it("matches every canonical alert state", () => {
    expect(
      isStationAttentionEvent({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
        agent: { ...agent, state: "stuck" },
      }),
    ).toBe(true);
  });

  it("ignores non-alert states", () => {
    expect(
      isStationAttentionEvent({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
        agent: { ...agent, state: "working", attention: "question" },
      }),
    ).toBe(false);
  });
});
