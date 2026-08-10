import { claudeHarnessCommandDefinition } from "@station/claude";
import { codexHarnessCommandDefinition } from "@station/codex";
import type { CliSetupHarnessId } from "@station/contracts";
import { cursorHarnessCommandDefinition } from "@station/cursor";
import { openCodeHarnessCommandDefinition } from "@station/opencode";
import { piHarnessCommandDefinition } from "@station/pi";
import { PROVIDER_HOOK_DEFINITIONS } from "../providerHookDefinitions.js";

type ProviderHookDefinition =
  (typeof PROVIDER_HOOK_DEFINITIONS)[keyof typeof PROVIDER_HOOK_DEFINITIONS];
type HarnessProviderHookDefinition = Exclude<ProviderHookDefinition, { readonly id: "worktrunk" }>;

export type SetupHarnessDefinition = {
  readonly id: CliSetupHarnessId;
  readonly displayName: string;
  readonly commandEnvVar: string;
  readonly commandFallback: string;
  readonly label: string;
  readonly guidedRank: number;
  readonly additionalUserCommandDirectories?: readonly string[];
  readonly providerHook?: HarnessProviderHookDefinition;
};

type SetupHarnessDefinitionMap = {
  readonly [Harness in CliSetupHarnessId]: SetupHarnessDefinition & {
    readonly id: Harness;
  };
};

/**
 * Canonical CLI setup policy for setup-managed harnesses; provider identity and command metadata
 * stay provider-owned, while declaration order preserves setup fact and presentation order.
 */
export const SETUP_HARNESS_DEFINITIONS: SetupHarnessDefinitionMap = {
  codex: {
    ...codexHarnessCommandDefinition,
    label: codexHarnessCommandDefinition.displayName,
    guidedRank: 1,
    providerHook: PROVIDER_HOOK_DEFINITIONS.codex,
  },
  cursor: {
    ...cursorHarnessCommandDefinition,
    label: "Cursor Agent",
    guidedRank: 2,
    providerHook: PROVIDER_HOOK_DEFINITIONS.cursor,
  },
  opencode: {
    ...openCodeHarnessCommandDefinition,
    label: openCodeHarnessCommandDefinition.displayName,
    guidedRank: 3,
    additionalUserCommandDirectories: [".opencode/bin"],
    providerHook: PROVIDER_HOOK_DEFINITIONS.opencode,
  },
  pi: {
    ...piHarnessCommandDefinition,
    label: piHarnessCommandDefinition.displayName,
    guidedRank: 4,
  },
  claude: {
    ...claudeHarnessCommandDefinition,
    label: claudeHarnessCommandDefinition.displayName,
    guidedRank: 0,
    providerHook: PROVIDER_HOOK_DEFINITIONS.claude,
  },
};
