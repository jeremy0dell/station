export const PROVIDER_HOOK_DEFINITIONS = {
  worktrunk: {
    id: "worktrunk",
    providerConfigFlag: "--worktrunk-config",
    supportsHookScript: false,
    supportsHookBin: true,
  },
  claude: {
    id: "claude",
    providerConfigFlag: "--claude-settings",
    supportsHookScript: true,
    supportsHookBin: true,
  },
  codex: {
    id: "codex",
    providerConfigFlag: "--codex-config",
    supportsHookScript: true,
    supportsHookBin: true,
  },
  cursor: {
    id: "cursor",
    providerConfigFlag: "--cursor-hooks",
    supportsHookScript: true,
    supportsHookBin: true,
  },
  opencode: {
    id: "opencode",
    providerConfigFlag: "--opencode-config-dir",
    supportsHookScript: true,
    supportsHookBin: false,
    hookScriptFlag: "--plugin-path",
  },
} as const;

export const providerHookDefinitions = Object.values(PROVIDER_HOOK_DEFINITIONS);
