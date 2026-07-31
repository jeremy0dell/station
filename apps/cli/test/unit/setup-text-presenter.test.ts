import { setupMessageRef } from "@station/setup-messages";
import { describe, expect, it } from "vitest";
import type { ProjectSetupView } from "../../src/commands/setup/presentation/projectSetupView.js";
import { createTextSetupPresenter } from "../../src/commands/setup/presenters/text.js";

describe("text setup presenter", () => {
  it("renders the semantic plan without compatibility keys or command payloads", () => {
    const presenter = createTextSetupPresenter();
    const view = readyView({
      checks: [
        check({
          id: "worktrunk-hooks",
          label: setupMessageRef("label.worktrunk-hooks"),
          explanation: setupMessageRef("check.worktrunk-hooks-defaults"),
          details: [
            { kind: "worktrunk-policy", value: "worktrunk-default" },
            { kind: "selection-origin", value: "configured" },
          ],
        }),
      ],
      actions: [trackingAction("codex")],
    });

    const output = presenter.renderPlan(view);

    expect(output).toContain("Worktrunk automation: worktrunk-default");
    expect(output).toContain("Install Codex tracking");
    expect(output).not.toContain("automationMode");
    expect(output).not.toContain("selectionSource");
    expect(output).not.toContain("command [");
    expect(output).not.toContain("hooks install codex");
    expect(output).not.toContain("setupRole");
  });

  it("renders a compact successful transcript with prepared agents and runnable next commands", () => {
    const presenter = createTextSetupPresenter();
    const view = readyView({
      checks: [trackingCheck("codex", "prepared"), trackingCheck("opencode", "prepared")],
    });

    const output = presenter.renderApplyResult(view);

    expect(output).toContain("Core setup complete. Tracking is prepared for Codex and OpenCode.");
    expect(output).toContain("Codex may require review");
    expect(output).toContain("/hooks");
    expect(output).toContain("  stn doctor\n  stn\n");
    expect(output).not.toContain("Remaining");
    expect(output).not.toContain("Completed Install");
  });

  it("keeps partial-failure evidence and recovery while allowing a later provider to complete", () => {
    const presenter = createTextSetupPresenter();
    const failure = presenter.renderProgressFailure(
      { label: "Install Codex tracking" },
      {
        tag: "ProviderTrackingError",
        code: "HOOK_OWNER_CONFLICT",
        message: "Another Station runtime owns the Codex hook.",
        hint: "stn hooks install codex --yes --takeover",
      },
    );
    const laterSuccess = presenter.renderProgressComplete({ label: "Install OpenCode tracking" });
    const final = presenter.renderApplyResult(
      readyView({
        checks: [
          trackingCheck("codex", "artifact-missing-or-drifted", "missing"),
          trackingCheck("opencode", "prepared"),
        ],
        actions: [trackingAction("codex")],
        result: {
          readiness: { launchReady: true, workflowReady: false, requiredMissing: 1 },
          requiredIssueCount: 1,
          warningCount: 0,
          selectedOperationCount: 1,
        },
      }),
    );
    const transcript = `${failure}\n${laterSuccess}\n${final}`;

    expect(transcript).toContain("Another Station runtime owns the Codex hook.");
    expect(transcript).toContain("HOOK_OWNER_CONFLICT");
    expect(transcript).toContain("stn hooks install codex --yes --takeover");
    expect(transcript).toContain("Completed: Install OpenCode tracking");
    expect(transcript).toContain(
      "/tmp/bin/stn --config /tmp/config.toml hooks install codex --yes",
    );
    expect(transcript).not.toMatch(/^\s*[[{]/m);
    expect(transcript).not.toMatch(/"(?:provider|commands|before|after|rawResult|data)"\s*:/);
  });

  it("preserves safely quoted launcher and PATH recovery", () => {
    const presenter = createTextSetupPresenter();
    const bin = "/tmp/installed path's bin";
    const output = presenter.renderApplyResult(
      readyView({
        checks: [
          check({
            id: "station-launchers",
            status: "warning",
            label: setupMessageRef("label.launchers"),
            explanation: setupMessageRef("check.launchers-installed-path", {
              launchers: "stn, stn-ingress, stn-tmux-popup",
            }),
            details: [
              { kind: "station-launcher", value: `${bin}/stn` },
              { kind: "ingress-launcher", value: `${bin}/stn-ingress` },
              { kind: "tmux-popup-launcher", value: `${bin}/stn-tmux-popup` },
              { kind: "launcher-directory", value: bin },
            ],
          }),
        ],
      }),
    );

    expect(output).toContain(`PATH='/tmp/installed path'\\''s bin'\${PATH:+":$PATH"}`);
    expect(output).toContain("'/tmp/installed path'\\''s bin/stn' doctor");
    expect(output).toContain("Future login shell launcher resolution remains unverified");
    expect(output).not.toContain("\n  stn doctor\n");
  });
});

function readyView(overrides: Partial<ProjectSetupView> = {}): ProjectSetupView {
  return {
    generatedAt: "2026-07-31T12:00:00.000Z",
    mode: "apply",
    title: setupMessageRef("setup.heading", { mode: "apply" }),
    selection: {
      source: "configured",
      summary: setupMessageRef("setup.selection-summary", { source: "configured" }),
      defaultHarness: "codex",
    },
    checks: [],
    actions: [],
    result: {
      readiness: { launchReady: true, workflowReady: true, requiredMissing: 0 },
      requiredIssueCount: 0,
      warningCount: 0,
      selectedOperationCount: 0,
    },
    configPath: "/tmp/config.toml",
    recovery: [
      { kind: "command", command: ["stn", "doctor"] },
      { kind: "command", command: ["stn"] },
    ],
    outcomes: [],
    ...overrides,
  };
}

function check(
  overrides: Partial<ProjectSetupView["checks"][number]> & {
    id: string;
    label: ProjectSetupView["checks"][number]["label"];
    explanation: ProjectSetupView["checks"][number]["explanation"];
  },
): ProjectSetupView["checks"][number] {
  return {
    tier: "recommended",
    status: "ok",
    details: [],
    ...overrides,
  };
}

function trackingCheck(
  harnessId: "codex" | "opencode",
  state: "prepared" | "artifact-missing-or-drifted",
  status: "ok" | "missing" = "ok",
): ProjectSetupView["checks"][number] {
  const label = harnessId === "codex" ? "Codex" : "OpenCode";
  return check({
    id: `harness-tracking:${harnessId}`,
    tier: "required",
    status,
    label: setupMessageRef("label.harness-tracking", { harness: label }),
    explanation:
      state === "prepared"
        ? setupMessageRef("check.tracking-prepared", { harness: label })
        : setupMessageRef("check.tracking-missing", { harnessId }),
    details: [
      { kind: "harness-identity", value: harnessId },
      { kind: "tracking-state", value: state },
    ],
  });
}

function trackingAction(harnessId: "codex"): ProjectSetupView["actions"][number] {
  return {
    id: `${harnessId}-hooks`,
    operationId: `prepare-harness-tracking:${harnessId}`,
    tier: "required",
    selected: true,
    label: setupMessageRef("action.harness-tracking-label", { harness: "Codex" }),
    explanation: setupMessageRef("action.harness-tracking-message", { harness: "Codex" }),
    execution: {
      kind: "command",
      command: [
        "/tmp/bin/stn",
        "--config",
        "/tmp/config.toml",
        "hooks",
        "install",
        harnessId,
        "--yes",
      ],
      purpose: "provider-tracking",
      provider: harnessId,
    },
  };
}
