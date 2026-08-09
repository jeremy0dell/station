import { cliSetupHarnessIds } from "@station/contracts";
import type { SupportedHarnessId } from "@station/setup-core";

export type SetupHarnessDefinition = {
  readonly id: SupportedHarnessId;
  readonly label: string;
  readonly envKey: string;
  readonly command: string;
  readonly guidedRank: number;
  readonly tracking: "external" | "none";
  readonly trackingNeedsIngressLauncher: boolean;
};

type SetupHarnessDefinitionMap = {
  readonly [Harness in SupportedHarnessId]: SetupHarnessDefinition & {
    readonly id: Harness;
  };
};

/**
 * Canonical CLI metadata for setup-managed harnesses; semantic order follows the shared contract,
 * while selection and provider behavior remain outside this table.
 */
export const SETUP_HARNESS_DEFINITIONS = {
  codex: {
    id: "codex",
    label: "Codex",
    envKey: "STATION_CODEX_BIN",
    command: "codex",
    guidedRank: 1,
    tracking: "external",
    trackingNeedsIngressLauncher: true,
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    envKey: "STATION_CURSOR_AGENT_BIN",
    command: "agent",
    guidedRank: 2,
    tracking: "external",
    trackingNeedsIngressLauncher: true,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    envKey: "STATION_OPENCODE_BIN",
    command: "opencode",
    guidedRank: 3,
    tracking: "external",
    trackingNeedsIngressLauncher: false,
  },
  pi: {
    id: "pi",
    label: "Pi",
    envKey: "STATION_PI_BIN",
    command: "pi",
    guidedRank: 4,
    tracking: "none",
    trackingNeedsIngressLauncher: false,
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    envKey: "STATION_CLAUDE_BIN",
    command: "claude",
    guidedRank: 0,
    tracking: "external",
    trackingNeedsIngressLauncher: true,
  },
} as const satisfies SetupHarnessDefinitionMap;

export const setupHarnessDefinitions = cliSetupHarnessIds.map(
  (harnessId) => SETUP_HARNESS_DEFINITIONS[harnessId],
);
