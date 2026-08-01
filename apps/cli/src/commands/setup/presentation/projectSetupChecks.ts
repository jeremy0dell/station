import { dirname } from "node:path";
import { setupMessageRef } from "@station/setup-messages";
import { stationUiInstallHint } from "../../../stationWorkspace.js";
import { setupLauncherExecutable } from "../checks/launchers.js";
import type { SetupFacts } from "../model.js";
import type { SetupDisplayDetail, SetupViewCheck } from "./setupViewTypes.js";

export function projectSetupEnvironmentChecks(facts: SetupFacts): readonly SetupViewCheck[] {
  return [
    stateDirectoryCheck(facts),
    socketEvidenceCheck(facts),
    ...(facts.compiled || facts.xcode.status !== "missing" ? [] : [xcodeCheck(facts)]),
    dependencyCheck(
      "worktrunk",
      setupMessageRef("label.worktrunk"),
      facts.worktrunk,
      "Worktrunk is required for core worktree setup.",
    ),
    dependencyCheck(
      "tmux",
      setupMessageRef("label.tmux"),
      facts.tmux,
      "tmux is required for the reference terminal workflow.",
    ),
    ...(facts.compiled
      ? []
      : [
          dependencyCheck(
            "bun",
            setupMessageRef("label.bun"),
            facts.bun,
            "Bun is required to run the STATION terminal UI (bare stn).",
          ),
        ]),
    gitCheck(facts),
  ];
}

export function projectSetupOperationalChecks(facts: SetupFacts): readonly SetupViewCheck[] {
  return [
    launcherCheck(facts),
    ...(facts.compiled ? [] : [stationUiCheck(facts)]),
    worktrunkShellIntegrationCheck(facts),
    tmuxPopupBindingCheck(facts),
    worktrunkHooksCheck(facts),
    diffnavCheck(facts),
    gitDeltaCheck(facts),
    {
      id: "doctor",
      tier: "recommended",
      status: "warning",
      label: setupMessageRef("label.doctor"),
      explanation: setupMessageRef("check.doctor-reminder"),
      details: [],
    },
  ];
}

function stateDirectoryCheck(facts: SetupFacts): SetupViewCheck {
  return {
    id: "state-dir",
    tier: "required",
    status: facts.stateDir.status === "ok" ? "ok" : "missing",
    label: setupMessageRef("label.state-directory"),
    explanation:
      facts.stateDir.status === "ok"
        ? setupMessageRef("check.state-directory-ready")
        : setupMessageRef("check.evidence", { message: facts.stateDir.message }),
    details: [{ label: setupMessageRef("detail.path"), value: facts.stateDir.path }],
  };
}

function socketEvidenceCheck(facts: SetupFacts): SetupViewCheck {
  return {
    id: "observer-socket-evidence",
    tier: "recommended",
    status: facts.socketEvidence.status === "ok" ? "ok" : "warning",
    label: setupMessageRef("label.socket-evidence"),
    explanation:
      facts.socketEvidence.status === "ok"
        ? setupMessageRef("check.socket-evidence-ready")
        : setupMessageRef("check.socket-evidence-missing", {
            command: facts.socketEvidence.command,
          }),
    details: [],
  };
}

function xcodeCheck(facts: SetupFacts): SetupViewCheck {
  if (facts.xcode.status !== "missing") {
    throw new Error("Command Line Tools are only projected when missing.");
  }
  return {
    id: "command-line-tools",
    tier: "required",
    status: "missing",
    label: setupMessageRef("label.command-line-tools"),
    explanation: setupMessageRef("check.evidence", { message: facts.xcode.message }),
    details: [],
  };
}

function dependencyCheck(
  id: string,
  label: SetupViewCheck["label"],
  dependency: SetupFacts["worktrunk"],
  fallback: string,
): SetupViewCheck {
  const details: SetupDisplayDetail[] = [];
  if (dependency.version !== undefined) {
    details.push({ label: setupMessageRef("detail.version"), value: dependency.version });
  }
  if (dependency.resolvedPath !== undefined) {
    details.push({
      label: setupMessageRef("detail.resolved-executable"),
      value: dependency.resolvedPath,
    });
  }
  return {
    id,
    tier: "required",
    status: dependency.status === "ok" ? "ok" : "missing",
    label,
    explanation:
      dependency.status === "ok"
        ? setupMessageRef("check.available", { label: messageLabel(label) })
        : setupMessageRef("check.evidence", { message: dependency.message ?? fallback }),
    details,
  };
}

function messageLabel(label: SetupViewCheck["label"]): string {
  switch (label.id) {
    case "label.worktrunk":
      return "Worktrunk / wt";
    case "label.tmux":
      return "tmux";
    case "label.bun":
      return "Bun";
    default:
      throw new Error(`Unsupported setup dependency label: ${label.id}`);
  }
}

function gitCheck(facts: SetupFacts): SetupViewCheck {
  if (facts.git.status === "missing") {
    return {
      id: "git-project",
      tier: "required",
      status: "missing",
      label: setupMessageRef("label.git"),
      explanation: setupMessageRef("check.evidence", { message: facts.git.message }),
      details: [
        { label: setupMessageRef("detail.default-branch"), value: facts.git.defaultBranch },
      ],
    };
  }
  if (facts.git.repository === "absent") {
    return {
      id: "git-project",
      tier: "required",
      status: "ok",
      label: setupMessageRef("label.git"),
      explanation: setupMessageRef("check.git-outside-repository"),
      details: [
        { label: setupMessageRef("detail.default-branch"), value: facts.git.defaultBranch },
      ],
    };
  }
  return {
    id: "git-project",
    tier: "required",
    status: "ok",
    label: setupMessageRef("label.git"),
    explanation: setupMessageRef("check.git-repository-ready"),
    details: [
      { label: setupMessageRef("detail.repository"), value: facts.git.root },
      { label: setupMessageRef("detail.default-branch"), value: facts.git.defaultBranch },
    ],
  };
}

function launcherCheck(facts: SetupFacts): SetupViewCheck {
  const entries = [
    ["stn", facts.launchers.station],
    ["stn-ingress", facts.launchers.ingress],
    ["stn-tmux-popup", facts.launchers.tmuxPopup],
  ] as const;
  const missing = entries.flatMap(([name, launcher]) =>
    launcher.status === "missing" ? [name] : [],
  );
  const checkout = entries.flatMap(([name, launcher]) =>
    launcher.source === "checkout" ? [name] : [],
  );
  const installed = entries.flatMap(([name, launcher]) =>
    launcher.source === "installed" ? [name] : [],
  );
  const details: SetupDisplayDetail[] = [
    {
      label: setupMessageRef("detail.station-launcher"),
      value: setupLauncherExecutable(facts.launchers.station),
    },
    {
      label: setupMessageRef("detail.ingress-launcher"),
      value: setupLauncherExecutable(facts.launchers.ingress),
    },
    {
      label: setupMessageRef("detail.tmux-popup-launcher"),
      value: setupLauncherExecutable(facts.launchers.tmuxPopup),
    },
  ];
  const explanation =
    missing.length > 0
      ? setupMessageRef("check.launchers-missing", { launchers: missing.join(", ") })
      : checkout.length > 0 && installed.length > 0
        ? setupMessageRef("check.launchers-mixed-path", {
            launchers: [...checkout, ...installed].join(", "),
          })
        : checkout.length > 0
          ? setupMessageRef("check.launchers-checkout-path", { launchers: checkout.join(", ") })
          : installed.length > 0
            ? setupMessageRef("check.launchers-installed-path", { launchers: installed.join(", ") })
            : setupMessageRef("check.launchers-ready");
  return {
    id: "station-launchers",
    tier: "recommended",
    status: missing.length > 0 || checkout.length > 0 || installed.length > 0 ? "warning" : "ok",
    label: setupMessageRef("label.launchers"),
    explanation,
    details,
  };
}

function stationUiCheck(facts: SetupFacts): SetupViewCheck {
  const explanation =
    facts.stationUi.status === "installed"
      ? setupMessageRef("check.station-ui-ready")
      : facts.stationUi.status === "missing"
        ? setupMessageRef("check.station-ui-missing", { installHint: stationUiInstallHint })
        : setupMessageRef("check.station-ui-skipped");
  return {
    id: "station-ui",
    tier: "recommended",
    status:
      facts.stationUi.status === "installed"
        ? "ok"
        : facts.stationUi.status === "missing"
          ? "warning"
          : "skipped",
    label: setupMessageRef("label.station-ui"),
    explanation,
    details: [],
  };
}

function worktrunkShellIntegrationCheck(facts: SetupFacts): SetupViewCheck {
  const details: SetupDisplayDetail[] = [];
  if (facts.worktrunkShellIntegration.shell !== undefined) {
    details.push({
      label: setupMessageRef("detail.shell"),
      value: facts.worktrunkShellIntegration.shell,
    });
  }
  if (facts.worktrunkShellIntegration.rcPath !== undefined) {
    details.push({
      label: setupMessageRef("detail.shell-config-path"),
      value: facts.worktrunkShellIntegration.rcPath,
    });
  }
  return {
    id: "worktrunk-shell-integration",
    tier: "recommended",
    status: facts.worktrunkShellIntegration.status,
    label: setupMessageRef("label.worktrunk-shell"),
    explanation: setupMessageRef("check.evidence", {
      message: facts.worktrunkShellIntegration.message,
    }),
    details,
  };
}

function tmuxPopupBindingCheck(facts: SetupFacts): SetupViewCheck {
  const binding = facts.tmuxBinding;
  const explanation =
    binding.status === "conflict"
      ? setupMessageRef("check.evidence", { message: binding.message })
      : facts.tmux.status !== "ok"
        ? setupMessageRef("check.tmux-popup-skipped")
        : facts.launchers.tmuxPopup.status !== "ok"
          ? setupMessageRef("check.tmux-popup-launcher-missing")
          : binding.status === "missing"
            ? setupMessageRef("check.evidence", { message: binding.message })
            : binding.insideTmux && binding.liveStatus === "missing"
              ? setupMessageRef("check.tmux-popup-persisted-missing")
              : binding.insideTmux && binding.liveStatus === "unknown"
                ? setupMessageRef("check.tmux-popup-persisted-unknown")
                : setupMessageRef("check.tmux-popup-ready");
  const status =
    binding.status === "conflict"
      ? "warning"
      : facts.tmux.status !== "ok"
        ? "skipped"
        : facts.launchers.tmuxPopup.status !== "ok" ||
            binding.status === "missing" ||
            (binding.insideTmux && binding.liveStatus !== "loaded")
          ? "warning"
          : "ok";
  return {
    id: "tmux-popup-binding",
    tier: "recommended",
    status,
    label: setupMessageRef("label.tmux-popup"),
    explanation,
    details:
      binding.status === "conflict"
        ? []
        : [{ label: setupMessageRef("detail.tmux-binding-key"), value: binding.bindingKey }],
  };
}

function worktrunkHooksCheck(facts: SetupFacts): SetupViewCheck {
  if (facts.worktrunk.status !== "ok") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: "skipped",
      label: setupMessageRef("label.worktrunk-hooks"),
      explanation: setupMessageRef("check.worktrunk-hooks-skipped"),
      details: [],
    };
  }
  if (facts.config.status !== "valid") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: "warning",
      label: setupMessageRef("label.worktrunk-hooks"),
      explanation: setupMessageRef("check.worktrunk-hooks-recommended"),
      details: [],
    };
  }
  if (facts.worktrunkAutomation.status !== "skipped") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: facts.worktrunkAutomation.status,
      label: setupMessageRef("label.worktrunk-hooks"),
      explanation: setupMessageRef("check.evidence", {
        message: facts.worktrunkAutomation.message,
      }),
      details: worktrunkAutomationDetails(facts),
    };
  }
  return {
    id: "worktrunk-hooks",
    tier: "recommended",
    status: "ok",
    label: setupMessageRef("label.worktrunk-hooks"),
    explanation: setupMessageRef("check.worktrunk-hooks-defaults"),
    details: [{ label: setupMessageRef("detail.worktrunk-policy"), value: "worktrunk-default" }],
  };
}

function worktrunkAutomationDetails(facts: SetupFacts): SetupDisplayDetail[] {
  const automation = facts.worktrunkAutomation;
  const details: SetupDisplayDetail[] = [
    { label: setupMessageRef("detail.worktrunk-policy"), value: automation.automationMode },
  ];
  if (automation.flag !== undefined) {
    details.push({ label: setupMessageRef("detail.worktrunk-flag"), value: automation.flag });
  }
  if (automation.missingSubcommands?.length) {
    details.push({
      label: setupMessageRef("detail.missing-subcommands"),
      value: automation.missingSubcommands.join(", "),
    });
  }
  return details;
}

function diffnavCheck(facts: SetupFacts): SetupViewCheck {
  return toolCheck(
    "diffnav",
    setupMessageRef("label.diffnav"),
    facts.diffnav,
    setupMessageRef("check.diffnav-ready"),
    setupMessageRef("check.diffnav-missing"),
  );
}

function gitDeltaCheck(facts: SetupFacts): SetupViewCheck {
  return toolCheck(
    "git-delta",
    setupMessageRef("label.git-delta"),
    facts.gitDelta,
    setupMessageRef("check.git-delta-ready"),
    setupMessageRef("check.git-delta-missing"),
  );
}

function toolCheck(
  id: string,
  label: SetupViewCheck["label"],
  fact: SetupFacts["diffnav"],
  ready: SetupViewCheck["explanation"],
  missing: SetupViewCheck["explanation"],
): SetupViewCheck {
  const details: SetupDisplayDetail[] = [];
  if (fact.resolvedPath !== undefined) {
    details.push({
      label: setupMessageRef("detail.resolved-executable"),
      value: fact.resolvedPath,
    });
  }
  return {
    id,
    tier: "required",
    status: fact.status === "ok" ? "ok" : "missing",
    label,
    explanation:
      fact.status === "ok"
        ? ready
        : fact.message === undefined
          ? missing
          : setupMessageRef("check.evidence", { message: fact.message }),
    details,
  };
}

export function launcherPathDirectory(facts: SetupFacts): string | undefined {
  const station = setupLauncherExecutable(facts.launchers.station);
  const directory = dirname(station);
  const siblings = [
    setupLauncherExecutable(facts.launchers.ingress),
    setupLauncherExecutable(facts.launchers.tmuxPopup),
  ];
  return facts.launchers.station.source === "installed" &&
    facts.launchers.ingress.source === "installed" &&
    facts.launchers.tmuxPopup.source === "installed" &&
    siblings.every((sibling) => dirname(sibling) === directory)
    ? directory
    : undefined;
}
