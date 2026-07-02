import { describe, expect, it } from "bun:test";
import { isUserInputRequestAttentionEvent } from "./attentionEvents.js";

const agent = {
  harness: "codex",
  state: "needs_attention",
  confidence: "high",
  reason: "Codex requested user input.",
  updatedAt: "2026-07-02T00:00:00.000Z",
} as const;

describe("isUserInputRequestAttentionEvent", () => {
  it("matches needs_attention events carrying a typed attention kind", () => {
    expect(
      isUserInputRequestAttentionEvent({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
        agent: { ...agent, attention: "question" },
      }),
    ).toBe(true);
  });

  it("ignores needs_attention events without an attention kind", () => {
    expect(
      isUserInputRequestAttentionEvent({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
        agent,
      }),
    ).toBe(false);
  });

  it("ignores non-attention states", () => {
    expect(
      isUserInputRequestAttentionEvent({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
        agent: { ...agent, state: "working", attention: "question" },
      }),
    ).toBe(false);
  });
});
