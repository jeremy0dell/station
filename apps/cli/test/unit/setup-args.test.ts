import { describe, expect, it } from "vitest";
import { parseSetupArgs } from "../../src/commands/setup/args.js";

describe("setup args", () => {
  it("parses supported setup commands", () => {
    expect(parseSetupArgs([])).toMatchObject({ kind: "guided" });
    expect(parseSetupArgs(["check", "--json"])).toMatchObject({ kind: "check", json: true });
    expect(parseSetupArgs(["plan", "--json"])).toMatchObject({ kind: "plan", json: true });
    expect(parseSetupArgs(["apply", "--yes"])).toMatchObject({ kind: "apply", yes: true });
    expect(parseSetupArgs(["apply", "--dry-run"])).toMatchObject({
      kind: "apply",
      dryRun: true,
    });
    expect(parseSetupArgs(["system", "--check"])).toMatchObject({ kind: "system", check: true });
  });

  it("validates unsupported flag combinations", () => {
    expect(() => parseSetupArgs(["bogus"])).toThrow("Unknown setup command: bogus");
    expect(() => parseSetupArgs(["--dry-run"])).toThrow(
      "stn setup --dry-run is not supported. Use: station setup apply --dry-run.",
    );
    expect(() => parseSetupArgs(["--check"])).toThrow(
      "stn setup --check is not supported. Use: station setup check.",
    );
    expect(() => parseSetupArgs(["--json"])).toThrow(
      "stn setup --json is not supported. Use: station setup check --json.",
    );
    expect(() => parseSetupArgs(["--yes"])).toThrow(
      "stn setup --yes is not supported. Use: station setup apply --yes.",
    );
    expect(() => parseSetupArgs(["--no-brew"])).toThrow(
      "stn setup --no-brew is not supported. Use: station setup check --no-brew.",
    );
    expect(() => parseSetupArgs(["check", "--yes"])).toThrow("stn setup check cannot use --yes.");
    expect(() => parseSetupArgs(["apply"])).toThrow("stn setup apply requires --yes or --dry-run.");
    expect(() => parseSetupArgs(["system"])).toThrow("stn setup system requires --check or --yes.");
    expect(() => parseSetupArgs(["apply", "--json"])).toThrow(
      "--json is supported for station setup check and station setup plan.",
    );
    expect(() => parseSetupArgs(["system", "--check", "--yes"])).toThrow(
      "stn setup system cannot use --check and --yes together.",
    );
  });
});
