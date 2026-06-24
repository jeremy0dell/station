import {
  EnsureAgentWorkspaceIntentSchema,
  TerminalCloseIntentSchema,
  TerminalFocusIntentSchema,
  TerminalIntentReceiptSchema,
  TerminalIntentSchema,
  terminalTargetObservationFromBinding,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-06-04T12:00:00.000Z";

describe("terminal intent schemas", () => {
  it("parses valid ensure, focus, and close intents", () => {
    expect(EnsureAgentWorkspaceIntentSchema.parse(ensureIntent())).toMatchObject({
      type: "session.ensureAgentWorkspace",
      commandId: "cmd_ensure",
      terminalProvider: "tmux",
      sessionId: "ses_web_feature",
      harness: {
        provider: "codex",
        mode: "interactive",
        profile: "default",
        permissionMode: "standard",
      },
    });
    expect(
      EnsureAgentWorkspaceIntentSchema.parse({
        ...ensureIntent(),
        resume: {
          target: {
            kind: "native-session",
            id: "codex_session_123",
          },
          previousSessionId: "ses_web_feature",
          recoveryHandleId: "rec_codex_123",
        },
      }),
    ).toMatchObject({
      resume: {
        target: {
          kind: "native-session",
          id: "codex_session_123",
        },
      },
    });
    expect(
      TerminalFocusIntentSchema.parse({
        type: "terminal.focus",
        commandId: "cmd_focus",
        terminalProvider: "tmux",
        subject: {
          sessionId: "ses_web_feature",
        },
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      }),
    ).toMatchObject({
      type: "terminal.focus",
      subject: {
        sessionId: "ses_web_feature",
      },
    });
    expect(
      TerminalCloseIntentSchema.parse({
        type: "terminal.close",
        commandId: "cmd_close",
        terminalProvider: "tmux",
        subject: {
          projectId: "web",
          worktreeId: "wt_web_feature",
        },
        force: true,
      }),
    ).toMatchObject({
      type: "terminal.close",
      force: true,
    });
  });

  it("rejects non-exact resume target selectors", () => {
    expect(
      EnsureAgentWorkspaceIntentSchema.safeParse({
        ...ensureIntent(),
        resume: {
          target: {
            kind: "last-for-worktree",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects Claude-specific auto permission mode on generic terminal intents", () => {
    expect(
      EnsureAgentWorkspaceIntentSchema.safeParse({
        ...ensureIntent(),
        harness: {
          ...ensureIntent().harness,
          provider: "claude",
          permissionMode: "auto",
        },
      }).success,
    ).toBe(false);
  });

  it("parses accepted and rejected terminal intent receipts", () => {
    expect(
      TerminalIntentReceiptSchema.parse({
        status: "accepted",
        accepted: true,
        commandId: "cmd_ensure",
        type: "session.ensureAgentWorkspace",
        terminalProvider: "tmux",
        timestamp: now,
      }),
    ).toMatchObject({
      status: "accepted",
      accepted: true,
    });

    const rejected = {
      status: "rejected",
      accepted: false,
      commandId: "cmd_ensure",
      type: "session.ensureAgentWorkspace",
      terminalProvider: "tmux",
      timestamp: now,
      error: {
        tag: "HarnessProviderError",
        code: "HARNESS_BUILD_LAUNCH_FAILED",
        message: "The harness provider failed to build a launch plan.",
        provider: "codex",
        hint: "Retry after fixing the provider configuration.",
      },
    };
    expect(TerminalIntentReceiptSchema.parse(rejected)).toEqual(rejected);
  });

  it("strictly rejects terminal topology fields and raw providerData on intents", () => {
    const topologyFields = [
      "targetId",
      "paneId",
      "windowId",
      "tabId",
      "sessionName",
      "tmuxPaneId",
      "tmuxWindowId",
      "tmuxSessionId",
      "ghosttyWindowId",
      "ghosttyTabId",
      "providerData",
    ];

    for (const field of topologyFields) {
      expect(
        TerminalIntentSchema.safeParse({
          ...ensureIntent(),
          [field]: "raw-provider-topology",
        }).success,
      ).toBe(false);
    }

    expect(
      TerminalFocusIntentSchema.safeParse({
        type: "terminal.focus",
        commandId: "cmd_focus",
        terminalProvider: "tmux",
        targetId: "tmux:station:@1:%2",
        subject: {
          sessionId: "ses_web_feature",
        },
      }).success,
    ).toBe(false);
  });

  it("requires focus and close subjects to stay product-oriented", () => {
    expect(
      TerminalFocusIntentSchema.safeParse({
        type: "terminal.focus",
        commandId: "cmd_focus",
        terminalProvider: "tmux",
        subject: {
          projectId: "web",
        },
      }).success,
    ).toBe(false);
    expect(
      TerminalCloseIntentSchema.safeParse({
        type: "terminal.close",
        commandId: "cmd_close",
        terminalProvider: "tmux",
        subject: {
          sessionId: "ses_web_feature",
          paneId: "%2",
        },
      }).success,
    ).toBe(false);
  });

  it("turns terminal identity bindings into normalized target observations", () => {
    expect(
      terminalTargetObservationFromBinding({
        binding: {
          provider: "tmux",
          targetId: "tmux:station:@1:%2",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          harnessBinding: {
            role: "main-agent",
            harnessProvider: "codex",
            worktreePath: "/tmp/station/web/feature",
          },
          confidence: "high",
          reason: "tmux opened the workspace.",
        },
        worktree: ensureIntent().worktree,
        observedAt: now,
      }),
    ).toEqual({
      id: "tmux:station:@1:%2",
      provider: "tmux",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      state: "open",
      cwd: "/tmp/station/web/feature",
      confidence: "high",
      reason: "tmux opened the workspace.",
      observedAt: now,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "codex",
        worktreePath: "/tmp/station/web/feature",
      },
    });
  });
});

function ensureIntent() {
  return {
    type: "session.ensureAgentWorkspace",
    commandId: "cmd_ensure",
    terminalProvider: "tmux",
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "codex",
        terminal: "tmux",
        layout: "agent-build-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
    worktree: {
      id: "wt_web_feature",
      provider: "worktrunk",
      projectId: "web",
      branch: "feature",
      path: "/tmp/station/web/feature",
      state: "exists",
      source: "worktrunk",
      confidence: "high",
      reason: "Worktree provider created the worktree.",
      observedAt: now,
    },
    sessionId: "ses_web_feature",
    harness: {
      provider: "codex",
      mode: "interactive",
      profile: "default",
      permissionMode: "standard",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    },
    layout: "agent-build-shell",
    focus: true,
    origin: {
      provider: "tmux",
      clientId: "client_1",
    },
    initialPrompt: "Start the feature.",
  };
}
