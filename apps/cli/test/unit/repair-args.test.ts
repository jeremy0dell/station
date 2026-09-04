import { describe, expect, it } from "vitest";
import { parseRepairRequest } from "../../src/commands/repair/args.js";

const digest = "a".repeat(64);

describe("repair arguments", () => {
  it("parses inventory and every exact preview selector", () => {
    expect(parseRepairRequest(["inventory", "--json"])).toEqual({
      kind: "inventory",
      output: "json",
    });
    expect(parseRepairRequest(["terminal", "reap", "--terminal", "term-1"])).toMatchObject({
      mode: "preview",
      selector: { kind: "terminal-reap", terminalTargetId: "term-1" },
    });
    expect(parseRepairRequest(["observer", "cleanup"])).toMatchObject({
      selector: { kind: "observer-cleanup" },
    });
    expect(parseRepairRequest(["recovery", "resume", "--handle", "rec-1"])).toMatchObject({
      selector: { kind: "recovery-resume", recoveryHandleId: "rec-1" },
    });
    expect(parseRepairRequest(["recovery", "prune", "--handle", "rec-1"])).toMatchObject({
      selector: { kind: "recovery-prune", recoveryHandleId: "rec-1" },
    });
  });

  it("requires both apply flags and one exact selector", () => {
    expect(
      parseRepairRequest([
        "terminal",
        "reap",
        "--yes",
        "--expect-plan",
        digest,
        "--terminal",
        "term-1",
      ]),
    ).toMatchObject({ mode: "apply", expectedPlanDigest: digest });
    expect(() => parseRepairRequest(["observer", "cleanup", "--yes"])).toThrow();
    expect(() => parseRepairRequest(["observer", "cleanup", "--expect-plan", digest])).toThrow();
    expect(() => parseRepairRequest(["terminal", "reap"])).toThrow();
    expect(() => parseRepairRequest(["recovery", "prune", "--handle", ""])).toThrow();
  });
});
