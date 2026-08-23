import {
  CreateSessionPayloadSchema,
  ForkSessionPayloadSchema,
  TerminalPlacementRequestSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const source = {
  provider: "tmux",
  targetId: "tmux:generation:$1:@1:%7",
  generation: "1:2:3",
  authorityId: "authority_1",
  expiresAt: "2026-08-20T12:00:00.000Z",
};

describe("terminal placement contracts", () => {
  it("supports only authority-qualified sibling and source-free detached placement", () => {
    expect(TerminalPlacementRequestSchema.safeParse({ intent: "sibling" }).success).toBe(false);
    expect(
      TerminalPlacementRequestSchema.safeParse({ intent: "new-container", source }).success,
    ).toBe(false);
    expect(TerminalPlacementRequestSchema.safeParse({ intent: "sibling", source }).success).toBe(
      true,
    );
  });

  it("keeps detached placement source-free", () => {
    expect(TerminalPlacementRequestSchema.parse({ intent: "detached" })).toEqual({
      intent: "detached",
    });
    expect(TerminalPlacementRequestSchema.safeParse({ intent: "detached", source }).success).toBe(
      false,
    );
  });

  it("requires create to name placement and rejects legacy terminal focus", () => {
    const payload = {
      projectId: "web",
      branch: "feature/session",
      harness: { provider: "scripted" },
      terminal: { provider: "tmux", layout: "default" },
      placement: { intent: "detached" },
    };
    expect(CreateSessionPayloadSchema.safeParse(payload).success).toBe(true);
    const { placement: _placement, ...withoutPlacement } = payload;
    expect(CreateSessionPayloadSchema.safeParse(withoutPlacement).success).toBe(false);
    expect(
      CreateSessionPayloadSchema.safeParse({
        ...payload,
        terminal: { ...payload.terminal, focus: true },
      }).success,
    ).toBe(false);
    expect(
      CreateSessionPayloadSchema.safeParse({
        ...payload,
        placement: { intent: "sibling", source: { ...source, provider: "other-terminal" } },
      }).success,
    ).toBe(false);
  });

  it("requires fork to name both its terminal provider and placement", () => {
    const payload = {
      projectId: "web",
      sourceWorktreeId: "wt_web_feature",
      branch: "feature/fork",
      terminal: { provider: "tmux" },
      placement: { intent: "detached" },
    };
    expect(ForkSessionPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      ForkSessionPayloadSchema.safeParse({
        projectId: payload.projectId,
        sourceWorktreeId: payload.sourceWorktreeId,
        branch: payload.branch,
      }).success,
    ).toBe(false);
  });
});
