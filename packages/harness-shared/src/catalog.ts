export const builtInHarnessIds = ["codex", "cursor", "opencode", "pi", "claude"] as const;

export type BuiltInHarnessId = (typeof builtInHarnessIds)[number];

export type BuiltInHarnessCatalogEntry = {
  readonly id: BuiltInHarnessId;
  readonly label: string;
  readonly envKey: string;
  readonly defaultCommand: string;
};

const builtInHarnessDetails = {
  codex: { label: "Codex", envKey: "STATION_CODEX_BIN", defaultCommand: "codex" },
  cursor: {
    label: "Cursor Agent",
    envKey: "STATION_CURSOR_AGENT_BIN",
    defaultCommand: "agent",
  },
  opencode: {
    label: "OpenCode",
    envKey: "STATION_OPENCODE_BIN",
    defaultCommand: "opencode",
  },
  pi: { label: "Pi", envKey: "STATION_PI_BIN", defaultCommand: "pi" },
  claude: { label: "Claude Code", envKey: "STATION_CLAUDE_BIN", defaultCommand: "claude" },
} as const satisfies Record<BuiltInHarnessId, Omit<BuiltInHarnessCatalogEntry, "id">>;

export const builtInHarnessCatalog: readonly BuiltInHarnessCatalogEntry[] = builtInHarnessIds.map(
  (id) => ({ id, ...builtInHarnessDetails[id] }),
);

export const builtInHarnessCatalogById: ReadonlyMap<BuiltInHarnessId, BuiltInHarnessCatalogEntry> =
  new Map(builtInHarnessCatalog.map((entry) => [entry.id, entry]));

export function isBuiltInHarnessId(value: string): value is BuiltInHarnessId {
  return builtInHarnessCatalogById.has(value as BuiltInHarnessId);
}
