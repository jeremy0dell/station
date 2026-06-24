import { describe, expect, it } from "vitest";
import { stableName, stableNameHash } from "../../src/names.js";

describe("stableName", () => {
  it("keeps already-safe display names readable in auto hash mode", () => {
    expect(
      stableName({
        prefix: "wt",
        profile: "id",
        display: ["web", "feature"],
        unique: ["worktree", "web", "/repo/.worktrees/feature", "feature"],
      }),
    ).toBe("wt_web_feature");
  });

  it("adds a deterministic suffix when display normalization is lossy", () => {
    const slashBranch = stableName({
      prefix: "wt",
      profile: "id",
      display: ["web", "feature/auth"],
      unique: ["worktree", "web", "/repo/.worktrees/feature-auth", "feature/auth"],
    });
    const underscoreBranch = stableName({
      prefix: "wt",
      profile: "id",
      display: ["web", "feature_auth"],
      unique: ["worktree", "web", "/repo/.worktrees/feature_auth", "feature_auth"],
    });

    expect(slashBranch).toMatch(/^wt_web_feature_auth_[a-f0-9]{10}$/);
    expect(underscoreBranch).toBe("wt_web_feature_auth");
    expect(slashBranch).not.toBe(underscoreBranch);
  });

  it("adds a deterministic suffix when lowercasing would hide case differences", () => {
    const mixedCase = stableName({
      profile: "tmux-window",
      display: ["web", "Feature"],
      unique: ["tmux-window", "web", "wt_web_Feature", "/repo/.worktrees/Feature"],
    });
    const lowercase = stableName({
      profile: "tmux-window",
      display: ["web", "feature"],
      unique: ["tmux-window", "web", "wt_web_feature", "/repo/.worktrees/feature"],
    });

    expect(mixedCase).toMatch(/^web-feature-[a-f0-9]{10}$/);
    expect(lowercase).toBe("web-feature");
    expect(mixedCase).not.toBe(lowercase);
  });

  it("keeps truncated names bounded and distinguished by the full unique value", () => {
    const left = stableName({
      profile: "tmux-window",
      display: ["web", "feature/customer-account-permissions-rollout-for-enterprise-alpha"],
      unique: [
        "tmux-window",
        "web",
        "wt_alpha",
        "/repo/.worktrees/customer-account-permissions-alpha",
      ],
    });
    const right = stableName({
      profile: "tmux-window",
      display: ["web", "feature/customer-account-permissions-rollout-for-enterprise-beta"],
      unique: [
        "tmux-window",
        "web",
        "wt_beta",
        "/repo/.worktrees/customer-account-permissions-beta",
      ],
    });

    expect(left.length).toBeLessThanOrEqual(48);
    expect(right.length).toBeLessThanOrEqual(48);
    expect(left).not.toBe(right);
    expect(left).toMatch(/-[a-f0-9]{10}$/);
    expect(right).toMatch(/-[a-f0-9]{10}$/);
  });

  it("supports explicit hash suffixes for provider-local uniqueness", () => {
    expect(
      stableName({
        profile: "path-segment",
        display: ["feature"],
        unique: ["worktree-path", "web", "/repo/.worktrees", "feature"],
        hash: "always",
        hashLength: 8,
      }),
    ).toMatch(/^feature-[a-f0-9]{8}$/);
  });

  it("exposes reusable hashing", () => {
    expect(stableNameHash(["web", "feature"], 8)).toMatch(/^[a-f0-9]{8}$/);
  });
});
