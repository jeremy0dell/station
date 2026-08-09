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
});
