import { describe, expect, it } from "vitest";
import { parseHostArgs } from "../../src/commands/host/args.js";

describe("parseHostArgs", () => {
  it("parses status without flags", () => {
    expect(parseHostArgs(["status"])).toEqual({
      action: "status",
      dryRun: false,
      fidelity: "processes",
    });
  });

  it("parses handoff dry-run and fidelity", () => {
    expect(parseHostArgs(["handoff", "--dry-run", "--fidelity", "screen"])).toEqual({
      action: "handoff",
      dryRun: true,
      fidelity: "screen",
    });
    expect(parseHostArgs(["handoff", "--fidelity=processes"])).toEqual({
      action: "handoff",
      dryRun: false,
      fidelity: "processes",
    });
  });

  it("rejects unknown actions, status flags, and bad fidelity", () => {
    expect(() => parseHostArgs([])).toThrow(/Usage/);
    expect(() => parseHostArgs(["status", "--dry-run"])).toThrow(/does not accept/);
    expect(() => parseHostArgs(["handoff", "--fidelity", "exact"])).toThrow(/fidelity/);
    expect(() => parseHostArgs(["handoff", "--wat"])).toThrow(/Unknown host flag/);
  });
});
