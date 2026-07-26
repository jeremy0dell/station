import { harnessDefinitions } from "./checks/harnesses.js";
import type { SetupAction, SetupFacts, SetupHarnessFact, SetupPlan } from "./model.js";

export type HarnessInstallOptions = {
  brewAvailable: boolean;
  homeDir: string;
  macos: boolean;
};

type HarnessInstallDefinition = {
  id: SetupHarnessFact["id"];
  command: readonly string[];
  message: string;
};

const harnessInstallOrder: readonly SetupHarnessFact["id"][] = [
  "codex",
  "cursor",
  "opencode",
  "pi",
  "claude",
];

export function missingHarnessInstallActions(
  harnesses: readonly SetupHarnessFact[],
  options: HarnessInstallOptions,
): SetupAction[] {
  const missing = new Set(
    harnesses.filter((harness) => harness.status === "missing").map((harness) => harness.id),
  );
  const actions: SetupAction[] = [];
  for (const id of harnessInstallOrder) {
    if (!missing.has(id)) continue;
    const harness = harnessDefinitions.find((candidate) => candidate.id === id);
    if (harness === undefined) continue;
    const definition = harnessInstallDefinition(id, options);
    actions.push({
      id: `install-harness-${id}`,
      kind: "run-command",
      tier: "required",
      selected: false,
      label: `Install ${harness.label}`,
      message: definition.message,
      command: [...definition.command],
      data: { harness: id },
    });
  }
  return actions;
}

function harnessInstallDefinition(
  id: SetupHarnessFact["id"],
  options: HarnessInstallOptions,
): HarnessInstallDefinition {
  const macBrewAvailable = options.macos && options.brewAvailable;
  switch (id) {
    case "codex":
      return macBrewAvailable
        ? {
            id,
            command: ["brew", "install", "--cask", "homebrew/cask/codex"],
            message: "Install Codex with the official Homebrew cask.",
          }
        : {
            id,
            command: ["/bin/bash", "-c", codexInstallerCommand],
            message: "Run OpenAI's unattended Codex installer without launching Codex.",
          };
    case "cursor":
      return {
        id,
        command: ["/bin/bash", "-c", downloadedInstallerCommand("https://cursor.com/install")],
        message: "Run Cursor's unattended Agent CLI installer.",
      };
    case "opencode":
      return options.brewAvailable
        ? {
            id,
            command: ["brew", "install", "homebrew/core/opencode"],
            message: "Install OpenCode with the official Homebrew formula.",
          }
        : {
            id,
            command: [
              "/bin/bash",
              "-c",
              downloadedInstallerCommand(
                "https://opencode.ai/install",
                '/bin/bash "$installer" --no-modify-path',
              ),
            ],
            message: "Run OpenCode's installer without modifying shell startup files.",
          };
    case "pi":
      return options.brewAvailable
        ? {
            id,
            command: ["brew", "install", "homebrew/core/pi-coding-agent"],
            message: "Install Pi with the official Homebrew formula.",
          }
        : {
            id,
            command: [
              "npm",
              "install",
              "--global",
              "--prefix",
              `${options.homeDir}/.local`,
              "--ignore-scripts",
              "--no-fund",
              "--no-audit",
              "@earendil-works/pi-coding-agent",
            ],
            message: "Install Pi with npm without lifecycle scripts or prompts.",
          };
    case "claude":
      return macBrewAvailable
        ? {
            id,
            command: ["brew", "install", "--cask", "homebrew/cask/claude-code"],
            message: "Install Claude Code with the official Homebrew cask.",
          }
        : {
            id,
            command: [
              "npm",
              "install",
              "--global",
              "--prefix",
              `${options.homeDir}/.local`,
              "--ignore-scripts",
              "--no-fund",
              "--no-audit",
              "@anthropic-ai/claude-code",
            ],
            message: "Install Claude Code with npm without lifecycle scripts or prompts.",
          };
  }
}

const codexInstallerCommand = [
  "set -eu",
  'installer="$(mktemp)"',
  'installer_home="$(mktemp -d)"',
  'cleanup() { rm -f "$installer"; rm -rf "$installer_home"; }',
  "trap cleanup EXIT",
  'curl -fsSL https://chatgpt.com/codex/install.sh -o "$installer"',
  'station_user_home="$HOME"',
  `station_codex_home="\${CODEX_HOME:-$station_user_home/.codex}"`,
  'HOME="$installer_home" CODEX_HOME="$station_codex_home" CODEX_INSTALL_DIR="$station_user_home/.local/bin" CODEX_NON_INTERACTIVE=1 /bin/sh "$installer"',
].join("; ");

function downloadedInstallerCommand(url: string, execute = '/bin/bash "$installer"'): string {
  return [
    "set -eu",
    'installer="$(mktemp)"',
    "trap 'rm -f \"$installer\"' EXIT",
    `curl -fsSL ${url} -o "$installer"`,
    execute,
  ].join("; ");
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
      launchReady:
        facts.stateDir.status === "ok" &&
        (facts.compiled || (facts.bun.status === "ok" && facts.stationUi.status !== "missing")),
      workflowReady: false,
      requiredOk: false,
      requiredMissing: 1,
      warnings: 0,
      selectedActions: actions.filter((action) => action.selected).length,
      selectionSource: "unresolved",
      configPath: facts.configPath,
    },
    nextSteps: [],
  };
}
