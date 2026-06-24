import { describe, expect, it } from "vitest";
import {
  buildTmuxTargetId,
  buildWorkbenchWindowName,
  defaultTmuxWorkbenchConfig,
  defaultTmuxWorkbenchSessionOptions,
  parseTmuxTargetId,
  tmuxNewWindowTarget,
  tmuxSessionOptionArgs,
} from "../../src/topology";

describe("tmux workbench topology", () => {
  it("uses the global station workbench defaults", () => {
    expect(defaultTmuxWorkbenchConfig).toMatchObject({
      topology: "workbench",
      workbenchSession: "station",
      windowNaming: "project-branch",
      primaryAgentPane: true,
      popupWidth: "50%",
      popupHeight: "50%",
      popupPosition: "C",
    });
  });

  it("applies Ghostty-like session options to the station workbench only", () => {
    expect(defaultTmuxWorkbenchSessionOptions).toEqual([
      { name: "mouse", value: "on" },
      { name: "history-limit", value: "100000" },
      { name: "set-clipboard", value: "on" },
    ]);
    expect(tmuxSessionOptionArgs("station", defaultTmuxWorkbenchSessionOptions[0])).toEqual([
      "set-option",
      "-t",
      "station",
      "mouse",
      "on",
    ]);
  });

  it("targets an existing session explicitly when appending a new window", () => {
    expect(tmuxNewWindowTarget("station")).toBe("station:");
  });

  it("builds stable safe window names from project and branch", () => {
    expect(buildWorkbenchWindowName({ projectId: "web", branch: "main" })).toBe("web-main");
    expect(
      buildWorkbenchWindowName({
        projectId: "web",
        branch: "feat/auth refresh!",
        worktreeId: "wt_web_auth_refresh",
        path: "/repo/.worktrees/auth-refresh",
      }),
    ).toMatch(/^web-feat-auth-refresh-[a-f0-9]{10}$/);
    expect(
      buildWorkbenchWindowName({
        projectId: "api",
        branch: "very/long/branch/name/with/many/parts/and-symbols",
        worktreeId: "wt_api_long",
        path: "/repo/.worktrees/very-long",
      }).length,
    ).toBeLessThanOrEqual(48);
  });

  it("can force a hash suffix when an existing unmatched tmux window owns the readable name", () => {
    expect(
      buildWorkbenchWindowName({
        projectId: "web",
        branch: "feature-auth",
        worktreeId: "wt_web_feature-auth",
        path: "/repo/.worktrees/feature-auth",
        forceHash: true,
      }),
    ).toMatch(/^web-feature-auth-[a-f0-9]{10}$/);
  });

  it("keeps truncated workbench window names unique", () => {
    const left = buildWorkbenchWindowName({
      projectId: "web",
      branch: "feature/customer-account-permissions-rollout-for-enterprise-alpha",
      worktreeId: "wt_web_alpha",
      path: "/repo/.worktrees/customer-account-permissions-alpha",
    });
    const right = buildWorkbenchWindowName({
      projectId: "web",
      branch: "feature/customer-account-permissions-rollout-for-enterprise-beta",
      worktreeId: "wt_web_beta",
      path: "/repo/.worktrees/customer-account-permissions-beta",
    });

    expect(left.length).toBeLessThanOrEqual(48);
    expect(right.length).toBeLessThanOrEqual(48);
    expect(left).not.toBe(right);
    expect(left).toMatch(/-[a-f0-9]{10}$/);
    expect(right).toMatch(/-[a-f0-9]{10}$/);
  });

  it("keeps hashed workbench window names stable across macOS /var aliases", () => {
    const branch = "station/customer-account-permissions-rollout-for-enterprise-alpha";
    const worktreeId = "wt_web_customer_account_permissions";
    const left = buildWorkbenchWindowName({
      projectId: "web",
      branch,
      worktreeId,
      path: "/var/folders/test/station/repo/.station-real-e2e/worktrees/feature",
    });
    const right = buildWorkbenchWindowName({
      projectId: "web",
      branch,
      worktreeId,
      path: "/private/var/folders/test/station/repo/.station-real-e2e/worktrees/feature",
    });

    expect(left).toBe(right);
  });

  it("round-trips opaque provider target IDs without making core parse tmux fields", () => {
    const id = buildTmuxTargetId({
      sessionId: "station",
      windowId: "@12",
      paneId: "%34",
    });

    expect(id).toBe("tmux:station:@12:%34");
    expect(parseTmuxTargetId(id)).toEqual({
      sessionId: "station",
      windowId: "@12",
      paneId: "%34",
    });
  });
});
