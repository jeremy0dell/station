import { harnessDefinitions } from "./checks/harnesses.js";
import type { SetupAction, SetupFacts, SetupHarnessFact, SetupPlan } from "./model.js";

type HarnessInstallDefinition = {
  id: SetupHarnessFact["id"];
  command: readonly string[];
  message: string;
};

const harnessInstallDefinitions: readonly HarnessInstallDefinition[] = [
  {
    id: "codex",
    command: ["sh", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
    message: "Install Codex CLI with the OpenAI installer.",
  },
  {
    id: "cursor",
    command: ["sh", "-c", "curl https://cursor.com/install -fsS | bash"],
    message: "Install Cursor Agent CLI.",
  },
  {
    id: "opencode",
    command: ["sh", "-c", "curl -fsSL https://opencode.ai/install | bash"],
    message: "Install OpenCode CLI.",
  },
  {
    id: "pi",
    command: ["npm", "install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"],
    message: "Install Pi CLI with npm.",
  },
  {
    id: "claude",
    command: ["npm", "install", "-g", "@anthropic-ai/claude-code"],
    message: "Install Claude Code CLI with npm.",
  },
] as const;

export function missingHarnessInstallActions(
  harnesses: readonly SetupHarnessFact[],
): SetupAction[] {
  const missing = new Set(
    harnesses.filter((harness) => harness.status === "missing").map((harness) => harness.id),
  );
  const actions: SetupAction[] = [];
  for (const definition of harnessInstallDefinitions) {
    if (!missing.has(definition.id)) continue;
    const harness = harnessDefinitions.find((candidate) => candidate.id === definition.id);
    if (harness === undefined) continue;
    actions.push({
      id: `install-harness-${definition.id}`,
      kind: "run-command",
      tier: "required",
      selected: false,
      label: `Install ${harness.label}`,
      message: definition.message,
      command: [...definition.command],
      data: { harness: definition.id },
    });
  }
  return actions;
}

export function isHarnessInstallAction(action: SetupAction): boolean {
  return action.id.startsWith("install-harness-");
}

export function harnessInstallPlan(facts: SetupFacts, actions: readonly SetupAction[]): SetupPlan {
  return {
    generatedAt: facts.generatedAt,
    mode: "apply",
    checks: [],
    actions: [...actions],
    summary: {
      requiredOk: false,
      requiredMissing: 1,
      warnings: 0,
      selectedActions: actions.filter((action) => action.selected).length,
      configPath: facts.configPath,
    },
    nextSteps: [],
  };
}
