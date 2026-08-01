import { readFileSync } from "node:fs";
import { setupMessageRef } from "@station/setup-messages";
import { describe, expect, it } from "vitest";
import type { ProjectSetupView } from "../../src/commands/setup/presentation/projectSetupView.js";
import { createTextSetupPresenter } from "../../src/commands/setup/presenters/text.js";

describe("text setup presenter", () => {
  it("does not derive semantics by slicing check or action IDs", () => {
    const source = readFileSync(
      new URL("../../src/commands/setup/presenters/text.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain(".id.startsWith");
    expect(source).not.toContain(".id.slice");
    expect(source).not.toContain("actions.find");
    expect(source).not.toContain("checks.find");
  });

  it("renders the semantic plan without compatibility keys or command payloads", () => {
    const presenter = createTextSetupPresenter();
    const view = readyView({
      checks: [
        check({
          id: "worktrunk-hooks",
          label: setupMessageRef("label.worktrunk-hooks"),
          explanation: setupMessageRef("check.worktrunk-hooks-defaults"),
          details: [
            {
              label: setupMessageRef("detail.worktrunk-policy"),
              value: "worktrunk-default",
            },
          ],
        }),
      ],
      actions: [trackingAction()],
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
      result: readyResult({
        kind: "complete",
        preparedHarnesses: [
          { id: "codex", label: "Codex" },
          { id: "opencode", label: "OpenCode" },
        ],
        showCodexReview: true,
        nextCommands: [["stn", "doctor"], ["stn"]],
      }),
    });

    const output = presenter.renderApplyResult(view);

    expect(output).toContain("Core setup complete. Tracking is prepared for Codex and OpenCode.");
    expect(output).toContain("Codex may require review");
    expect(output).toContain("/hooks");
    expect(output).toContain("  stn doctor\n  stn\n");
    expect(output).not.toContain("Remaining");
    expect(output).not.toContain("Completed Install");
  });

  it("keeps partial-failure evidence and projected tracking recovery", () => {
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
        result: blockedResult(
          setupMessageRef("check.tracking-missing", { harnessId: "codex" }),
          setupMessageRef("recovery.tracking"),
          [["/tmp/bin/stn", "--config", "/tmp/config.toml", "hooks", "install", "codex", "--yes"]],
        ),
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
    const bin = "/tmp/station/bin";
    const launcherCheck = check({
      id: "station-launchers",
      status: "warning",
      label: setupMessageRef("label.launchers"),
      explanation: setupMessageRef("check.launchers-installed-path", {
        launchers: "stn, stn-ingress, stn-tmux-popup",
      }),
      details: [
        { label: setupMessageRef("detail.station-launcher"), value: `${bin}/stn` },
        { label: setupMessageRef("detail.ingress-launcher"), value: `${bin}/stn-ingress` },
        { label: setupMessageRef("detail.tmux-popup-launcher"), value: `${bin}/stn-tmux-popup` },
      ],
    });
    const output = createTextSetupPresenter().renderApplyResult(
      readyView({
        checks: [launcherCheck],
        result: readyResult({
          kind: "complete",
          preparedHarnesses: [],
          showCodexReview: false,
          launcherWarning: {
            check: launcherCheck,
            stationExecutable: `${bin}/stn`,
            pathDirectory: bin,
          },
          nextCommands: [[`${bin}/stn`, "doctor"], [`${bin}/stn`]],
        }),
      }),
    );

    expect(output).toContain(`PATH='/tmp/station/bin'\${PATH:+":$PATH"}`);
    expect(output).toContain("'/tmp/station/bin/stn' doctor");
    expect(output).toContain("Future login shell launcher resolution remains unverified");
    expect(output).not.toContain("\n  stn doctor\n");
  });

  it("styles statuses while preserving visual alignment and disables ANSI on request", () => {
    const checks = [
      check({
        id: "one",
        label: setupMessageRef("label.git"),
        explanation: setupMessageRef("check.git-repository-ready"),
      }),
      check({
        id: "two",
        status: "warning",
        label: setupMessageRef("label.launchers"),
        explanation: setupMessageRef("check.launchers-missing", { launchers: "stn" }),
      }),
    ];
    const colored = createTextSetupPresenter({ color: true }).renderPlan(readyView({ checks }));
    const plain = createTextSetupPresenter({ color: false }).renderPlan(readyView({ checks }));

    expect(colored).toContain("\u001b[32mOK\u001b[0m");
    expect(colored).toContain("\u001b[33mWARN\u001b[0m");
    const visible = colored
      .replaceAll("\u001b[32m", "")
      .replaceAll("\u001b[33m", "")
      .replaceAll("\u001b[0m", "");
    const rows = visible
      .split("\n")
      .filter(
        (line) => line.includes("Git is available") || line.includes("These Station launchers"),
      );
    expect(rows[0]?.indexOf("Git is available")).toBe(rows[1]?.indexOf("These Station launchers"));
    expect(plain).not.toContain("\u001b[");
  });

  it("renders Git-specific and generic blocked results without inspecting check IDs", () => {
    const presenter = createTextSetupPresenter();
    const git = presenter.renderApplyResult(
      readyView({
        result: {
          ...notReadyResult(),
          apply: {
            kind: "message",
            message: setupMessageRef("check.evidence", { message: "Repair Git ownership." }),
          },
        },
      }),
    );
    const generic = presenter.renderApplyResult(
      readyView({
        result: blockedResult(
          setupMessageRef("recovery.core-incomplete"),
          setupMessageRef("recovery.then-run"),
          [["stn", "setup", "check"]],
        ),
      }),
    );

    expect(git).toBe("Repair Git ownership.\n");
    expect(generic).toContain("Core setup is incomplete.");
    expect(generic).toContain("stn setup check");
  });

  it("renders dry-run SKIP statuses and config-write failure results", () => {
    const presenter = createTextSetupPresenter();
    const dryRun = presenter.renderPlan(
      readyView({ actions: [{ ...trackingAction(), status: "skipped" }] }),
    );
    const failed = presenter.renderApplyResult(
      readyView({
        result: {
          ...notReadyResult(),
          apply: {
            kind: "config-write-failed",
            message: setupMessageRef("guided.config-write-failed"),
          },
        },
      }),
    );

    expect(dryRun).toContain("SKIP      Install Codex tracking");
    expect(failed).toContain("Config write failed. Run: stn setup plan");
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
    result: readyResult({
      kind: "complete",
      preparedHarnesses: [],
      showCodexReview: false,
      nextCommands: [["stn", "doctor"], ["stn"]],
    }),
    configPath: "/tmp/config.toml",
    recovery: [
      { kind: "command", command: ["stn", "doctor"] },
      { kind: "command", command: ["stn"] },
    ],
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

function trackingAction(): ProjectSetupView["actions"][number] {
  return {
    id: "codex-hooks",
    kind: "prepare-harness-tracking",
    tier: "required",
    selected: true,
    label: setupMessageRef("action.harness-tracking-label", { harness: "Codex" }),
    explanation: setupMessageRef("action.harness-tracking-message", { harness: "Codex" }),
  };
}

function readyResult(
  apply: Extract<ProjectSetupView["result"]["apply"], { kind: "complete" }>,
): ProjectSetupView["result"] {
  return {
    readiness: { launchReady: true, workflowReady: true, requiredMissing: 0 },
    requiredIssueCount: 0,
    selectedOperationCount: 0,
    apply,
  };
}

function notReadyResult(): Omit<ProjectSetupView["result"], "apply"> {
  return {
    readiness: { launchReady: true, workflowReady: false, requiredMissing: 1 },
    requiredIssueCount: 1,
    selectedOperationCount: 1,
  };
}

function blockedResult(
  title: Extract<ProjectSetupView["result"]["apply"], { kind: "blocked" }>["title"],
  detail: Extract<ProjectSetupView["result"]["apply"], { kind: "blocked" }>["detail"],
  commands: readonly (readonly string[])[],
): ProjectSetupView["result"] {
  return {
    ...notReadyResult(),
    apply: { kind: "blocked", title, detail, commands },
  };
}
