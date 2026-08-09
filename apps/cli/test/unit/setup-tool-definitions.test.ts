import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setupToolDefinitions } from "../../src/commands/setup/toolDefinitions.js";

describe("setup tool definitions", () => {
  it("pins the complete CLI metadata and canonical tool order", () => {
    const metadata = setupToolDefinitions.map(
      ({ id, factKey, label, displayName, availabilityName, command, formula, formulaUrl }) =>
        [id, factKey, label.id, displayName, availabilityName, command, formula, formulaUrl].join(
          "|",
        ),
    );

    expect(metadata).toEqual([
      "worktrunk|worktrunk|label.worktrunk|Worktrunk|Worktrunk / wt|wt|worktrunk|https://formulae.brew.sh/formula/worktrunk",
      "tmux|tmux|label.tmux|tmux|tmux|tmux|tmux|https://formulae.brew.sh/formula/tmux",
      "bun|bun|label.bun|Bun|Bun|bun|bun|https://formulae.brew.sh/formula/bun",
      "diff-viewer|diffViewer|label.diff-viewer|Hunk|Hunk|hunk|hunk|https://formulae.brew.sh/formula/hunk",
    ]);
  });

  it("keeps setup-owned command and formula metadata behind the canonical definitions", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const system = source("../../src/commands/setup/checks/system.ts");
    const config = source("../../src/commands/setup/adapters/config.ts");
    const tmuxBinding = source("../../src/commands/setup/checks/tmuxBinding.ts");
    const guided = source("../../src/commands/setup/session/runGuidedSetupSession.ts");
    const json = source("../../src/commands/setup/presenters/json.ts");
    const messages = source("../../../../packages/setup-messages/src/catalog.ts");

    expect(system).not.toContain('command: "bun"');
    expect(config).not.toContain('detectedCommand(facts.worktrunk, "wt")');
    expect(config).not.toContain('detectedOptionalCommand(facts.tmux, "tmux")');
    expect(tmuxBinding).not.toContain('?? "tmux"');
    expect(guided).toContain("setupToolDefinitions.some");
    expect(json).not.toMatch(/brew install (?:bun|hunk)/);
    expect(messages).not.toMatch(/brew install (?:bun|hunk)/);
  });
});
