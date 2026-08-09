import type { SetupToolInstallOperation } from "@station/setup-core";
import { type SetupMessageRef, setupMessageRef } from "@station/setup-messages";

type SetupToolDefinition = {
  readonly factKey: "worktrunk" | "tmux" | "bun" | "diffViewer";
  readonly label: SetupMessageRef;
  readonly displayName: string;
  readonly availabilityName: string;
  readonly command: string;
  readonly formula: string;
  readonly formulaUrl: string;
};

type SetupToolDefinitionMap = {
  readonly [Tool in SetupToolInstallOperation["tool"]]: SetupToolDefinition & { readonly id: Tool };
};
/** Canonical CLI metadata for setup-managed tools; declaration order preserves prerequisite installation and presentation order, while applicability and readiness remain setup-core policy. */
export const SETUP_TOOL_DEFINITIONS = {
  worktrunk: {
    id: "worktrunk",
    factKey: "worktrunk",
    label: setupMessageRef("label.worktrunk"),
    displayName: "Worktrunk",
    availabilityName: "Worktrunk / wt",
    command: "wt",
    formula: "worktrunk",
    formulaUrl: "https://formulae.brew.sh/formula/worktrunk",
  },
  tmux: {
    id: "tmux",
    factKey: "tmux",
    label: setupMessageRef("label.tmux"),
    displayName: "tmux",
    availabilityName: "tmux",
    command: "tmux",
    formula: "tmux",
    formulaUrl: "https://formulae.brew.sh/formula/tmux",
  },
  bun: {
    id: "bun",
    factKey: "bun",
    label: setupMessageRef("label.bun"),
    displayName: "Bun",
    availabilityName: "Bun",
    command: "bun",
    formula: "bun",
    formulaUrl: "https://formulae.brew.sh/formula/bun",
  },
  "diff-viewer": {
    id: "diff-viewer",
    factKey: "diffViewer",
    label: setupMessageRef("label.diff-viewer"),
    displayName: "Hunk",
    availabilityName: "Hunk",
    command: "hunk",
    formula: "hunk",
    formulaUrl: "https://formulae.brew.sh/formula/hunk",
  },
} as const satisfies SetupToolDefinitionMap;

export const setupToolDefinitions = Object.values(SETUP_TOOL_DEFINITIONS);
