import { CliSetupHarnessIdSchema } from "@station/contracts";
import { setupMessageRef } from "@station/setup-messages";
import type { SetupFacts } from "../adapters/inspectionTypes.js";
import type { SetupDisplayDetail, SetupViewCheck } from "./setupViewTypes.js";

export function projectSetupConfigChecks(facts: SetupFacts): readonly SetupViewCheck[] {
  const config = projectConfigCheck(facts);
  if (facts.config.status !== "valid" || (facts.config.diagnostics?.length ?? 0) === 0) {
    return [config];
  }
  const diagnostics = facts.config.diagnostics ?? [];
  const details: SetupDisplayDetail[] = [
    { label: setupMessageRef("detail.path"), value: facts.config.path },
  ];
  if (facts.config.matchedProject !== undefined) {
    details.push({
      label: setupMessageRef("detail.repository"),
      value: facts.config.matchedProject.id,
    });
  }
  return [
    config,
    {
      id: "config-diagnostics",
      tier: "recommended",
      status: "warning",
      label: setupMessageRef("label.config-diagnostics"),
      explanation: setupMessageRef("check.config-diagnostics", {
        count: diagnostics.length,
        messages: diagnostics.map((diagnostic) => diagnostic.message).join("; "),
      }),
      details,
    },
  ];
}

function projectConfigCheck(facts: SetupFacts): SetupViewCheck {
  if (facts.config.status !== "valid") {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: setupMessageRef("label.config"),
      explanation: setupMessageRef("check.evidence", { message: facts.config.message }),
      details: [{ label: setupMessageRef("detail.path"), value: facts.config.path }],
    };
  }
  const details = [
    { label: setupMessageRef("detail.path"), value: facts.config.path },
    { label: setupMessageRef("detail.default-agent"), value: facts.config.defaults.harness },
  ];
  if (facts.config.defaults.worktreeProvider !== "worktrunk") {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: setupMessageRef("label.config"),
      explanation: setupMessageRef("check.config-worktree-provider", {
        provider: facts.config.defaults.worktreeProvider,
      }),
      details,
    };
  }
  if (facts.config.defaults.terminal !== "tmux") {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: setupMessageRef("label.config"),
      explanation: setupMessageRef("check.config-terminal", {
        terminal: facts.config.defaults.terminal,
      }),
      details,
    };
  }
  if (!CliSetupHarnessIdSchema.safeParse(facts.config.defaults.harness).success) {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: setupMessageRef("label.config"),
      explanation: setupMessageRef("check.config-harness", {
        harness: facts.config.defaults.harness,
      }),
      details,
    };
  }
  return {
    id: "config",
    tier: "required",
    status: "ok",
    label: setupMessageRef("label.config"),
    explanation: setupMessageRef("check.config-core-ready"),
    details,
  };
}
