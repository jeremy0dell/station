import { describe, expect, it } from "vitest";
import {
  builtInHarnessCatalog,
  builtInHarnessCatalogById,
  builtInHarnessIds,
  isBuiltInHarnessId,
} from "../../src/catalog.js";

describe("built-in harness catalog", () => {
  it("keeps the canonical setup order and unique IDs", () => {
    expect(builtInHarnessCatalog.map((entry) => entry.id)).toEqual([
      "codex",
      "cursor",
      "opencode",
      "pi",
      "claude",
    ]);
    expect(new Set(builtInHarnessIds).size).toBe(builtInHarnessIds.length);
  });

  it("exposes commands, environment keys, and an ID lookup", () => {
    expect(builtInHarnessCatalog).toEqual([
      { id: "codex", label: "Codex", envKey: "STATION_CODEX_BIN", defaultCommand: "codex" },
      {
        id: "cursor",
        label: "Cursor Agent",
        envKey: "STATION_CURSOR_AGENT_BIN",
        defaultCommand: "agent",
      },
      {
        id: "opencode",
        label: "OpenCode",
        envKey: "STATION_OPENCODE_BIN",
        defaultCommand: "opencode",
      },
      { id: "pi", label: "Pi", envKey: "STATION_PI_BIN", defaultCommand: "pi" },
      {
        id: "claude",
        label: "Claude Code",
        envKey: "STATION_CLAUDE_BIN",
        defaultCommand: "claude",
      },
    ]);
    expect(builtInHarnessCatalogById.get("cursor")?.defaultCommand).toBe("agent");
    expect(isBuiltInHarnessId("claude")).toBe(true);
    expect(isBuiltInHarnessId("custom-agent")).toBe(false);
  });
});
