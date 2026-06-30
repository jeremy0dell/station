import { machineProfiles } from "@station/testing";
import { describe, expect, it } from "vitest";

// packages/testing/src/setupProfiles.ts is the single source of truth for setup
// outcome profiles. The tier-2 (docker) and tier-3 (macOS) runners hand-copy their
// own expectation tables (they run under plain `node`, which cannot import the TS
// package). This test keeps those copies honest: every runner entry must match a
// canonical profile's exitCode/requiredOk and assert only a subset of its checks
// with identical statuses. A canonical change the copies fail to track turns red.

const canonical = new Map(machineProfiles.map((profile) => [profile.name, profile.expect]));

// The container Dockerfile base stage is named "happy-linux"; it is the canonical
// "all-tools-present" profile under a different name.
const aliases: Record<string, string> = { "happy-linux": "all-tools-present" };

type RunnerEntry = {
  exitCode?: number;
  requiredOk?: boolean;
  checks?: Record<string, string>;
};

function assertSubsetOfCanonical(table: Record<string, RunnerEntry>): void {
  for (const [name, entry] of Object.entries(table)) {
    const expected = canonical.get(aliases[name] ?? name);
    expect(expected, `${name} is not a canonical profile`).toBeDefined();
    if (expected === undefined) continue;

    expect(entry.exitCode, `${name} exitCode`).toBe(expected.exitCode);
    if (entry.requiredOk !== undefined) {
      expect(entry.requiredOk, `${name} requiredOk`).toBe(expected.requiredOk);
    }
    for (const [id, status] of Object.entries(entry.checks ?? {})) {
      expect(expected.checks[id], `${name}.${id}`).toBe(status);
    }
  }
}

describe("setup profile runner tables stay a subset of the canonical contract", () => {
  it("container runner (run-setup-container.mjs)", async () => {
    const { expectations } = await import(
      "../../../../scripts/test-runners/run-setup-container.mjs"
    );
    assertSubsetOfCanonical(expectations);
  });

  it("macOS runner (run-setup-macos.mjs)", async () => {
    const { profiles } = await import("../../../../tests/env/macos/run-setup-macos.mjs");
    assertSubsetOfCanonical(profiles);
  });
});
