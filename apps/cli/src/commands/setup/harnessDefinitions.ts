import { claudeHarnessProviderDefinition } from "@station/claude";
import { codexHarnessProviderDefinition } from "@station/codex";
import type { CliSetupHarnessId } from "@station/contracts";
import { cursorHarnessProviderDefinition } from "@station/cursor";
import { openCodeHarnessProviderDefinition } from "@station/opencode";
import { piHarnessProviderDefinition } from "@station/pi";
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
    ...codexHarnessProviderDefinition,
    label: codexHarnessProviderDefinition.displayName,
    guidedRank: 1,
    providerHook: PROVIDER_HOOK_DEFINITIONS.codex,
  },
  cursor: {
    ...cursorHarnessProviderDefinition,
    label: "Cursor Agent",
    guidedRank: 2,
    providerHook: PROVIDER_HOOK_DEFINITIONS.cursor,
  },
  opencode: {
    ...openCodeHarnessProviderDefinition,
    label: openCodeHarnessProviderDefinition.displayName,
    guidedRank: 3,
    additionalUserCommandDirectories: [".opencode/bin"],
    providerHook: PROVIDER_HOOK_DEFINITIONS.opencode,
  },
  pi: {
    ...piHarnessProviderDefinition,
    label: piHarnessProviderDefinition.displayName,
    guidedRank: 4,
  },
  claude: {
    ...claudeHarnessProviderDefinition,
    label: claudeHarnessProviderDefinition.displayName,
    guidedRank: 0,
    providerHook: PROVIDER_HOOK_DEFINITIONS.claude,
  },
};

export const setupHarnessDefinitions = Object.values(SETUP_HARNESS_DEFINITIONS);
