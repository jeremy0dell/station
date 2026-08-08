import { describe, expect, it } from "bun:test";
import {
  attentionKey,
  isAttentionDismissed,
  type AttentionDismissalMode,
} from "./attentionDismissal.js";

describe("attentionKey", () => {
  it("prefers the session id and falls back to the worktree id", () => {
    expect(attentionKey("ses_1", "wt_1")).toBe("ses_1");
    expect(attentionKey(undefined, "wt_1")).toBe("wt_1");
  });
});

describe("isAttentionDismissed", () => {
  const now = 1_000_000;
  const indefinite: AttentionDismissalMode = { kind: "indefinite" };
  const timeout: AttentionDismissalMode = { kind: "timeout", timeoutMs: 60_000 };

  it("is false for an unknown key", () => {
    expect(isAttentionDismissed({}, "ses_1", now)).toBe(false);
    expect(isAttentionDismissed({ ses_other: now }, "ses_1", now)).toBe(false);
  });

  it("keeps a dismissed key quiet indefinitely in indefinite mode", () => {
    expect(isAttentionDismissed({ ses_1: now - 1000 }, "ses_1", now, indefinite)).toBe(true);
    expect(isAttentionDismissed({ ses_1: now - 3_600_000 }, "ses_1", now, indefinite)).toBe(true);
  });

  it("expires a dismissal in timeout mode once timeoutMs elapses", () => {
    expect(isAttentionDismissed({ ses_1: now - 59_000 }, "ses_1", now, timeout)).toBe(true);
    expect(isAttentionDismissed({ ses_1: now - 61_000 }, "ses_1", now, timeout)).toBe(false);
  });
});
