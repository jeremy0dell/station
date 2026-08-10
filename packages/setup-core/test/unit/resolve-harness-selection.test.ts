import { type CliSetupHarnessId, CliSetupHarnessIdSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { type HarnessSelectionFacts, resolveHarnessSelection } from "../../src/index.js";

const harnessIds: readonly CliSetupHarnessId[] = ["codex", "cursor", "opencode", "pi", "claude"];

describe("resolveHarnessSelection", () => {
  it("preserves a supported configured default even when it is unavailable", () => {
    expect(
      resolveHarnessSelection(selectionFacts({ config: "codex", available: ["pi"] }), {
        kind: "automatic",
      }),
    ).toEqual({
      outcome: "selected",
      source: "configured",
      requiredHarnessIds: ["codex"],
      defaultHarness: "codex",
    });
  });

  it("preserves a supported configured default when its availability fact is absent", () => {
    expect(
      resolveHarnessSelection(
        {
          config: { status: "valid", defaultHarness: "codex" },
          harnesses: [{ id: "pi", availability: "unavailable" }],
        },
        { kind: "automatic" },
      ),
    ).toEqual({
      outcome: "selected",
      source: "configured",
      requiredHarnessIds: ["codex"],
      defaultHarness: "codex",
    });
  });

  it("deduplicates explicit choices and appends the authoritative configured default", () => {
    expect(
      resolveHarnessSelection(selectionFacts({ config: "codex", available: ["opencode"] }), {
        kind: "explicit",
        harnessIds: ["opencode", "pi", "opencode"],
      }),
    ).toEqual({
      outcome: "selected",
      source: "explicit",
      requiredHarnessIds: ["opencode", "pi", "codex"],
      defaultHarness: "codex",
    });
  });

  it("uses the first explicit choice as the default only when no valid config exists", () => {
    expect(
      resolveHarnessSelection(selectionFacts({ config: "missing", available: ["codex"] }), {
        kind: "explicit",
        harnessIds: ["pi", "codex"],
      }),
    ).toEqual({
      outcome: "selected",
      source: "explicit",
      requiredHarnessIds: ["pi", "codex"],
      defaultHarness: "pi",
    });

    expect(
      resolveHarnessSelection(selectionFacts({ config: "invalid", available: ["codex"] }), {
        kind: "explicit",
        harnessIds: ["codex"],
      }),
    ).toMatchObject({ outcome: "selected", defaultHarness: "codex" });
  });

  it("infers exactly one available harness", () => {
    expect(
      resolveHarnessSelection(selectionFacts({ config: "missing", available: ["cursor"] }), {
        kind: "automatic",
      }),
    ).toEqual({
      outcome: "selected",
      source: "inferred",
      requiredHarnessIds: ["cursor"],
      defaultHarness: "cursor",
    });
  });

  it("returns ambiguous candidates in fact order without selecting one", () => {
    expect(
      resolveHarnessSelection(
        selectionFacts({
          config: "missing",
          available: ["opencode", "codex", "pi"],
          order: ["pi", "codex", "opencode", "cursor", "claude"],
        }),
        { kind: "automatic" },
      ),
    ).toEqual({
      outcome: "ambiguous",
      candidateHarnessIds: ["pi", "codex", "opencode"],
    });
  });

  it.each([
    {
      name: "empty explicit input",
      facts: selectionFacts({ config: "missing", available: ["codex"] }),
      intent: { kind: "explicit", harnessIds: [] } as const,
      reason: "empty-explicit-selection",
    },
    {
      name: "zero discovery candidates",
      facts: selectionFacts({ config: "missing", available: [] }),
      intent: { kind: "automatic" } as const,
      reason: "no-available-harness",
    },
    {
      name: "invalid automatic config",
      facts: selectionFacts({ config: "invalid", available: ["codex"] }),
      intent: { kind: "automatic" } as const,
      reason: "invalid-config",
    },
    {
      name: "unsupported configured default",
      facts: selectionFacts({ config: "custom", available: ["codex"] }),
      intent: { kind: "automatic" } as const,
      reason: "unsupported-configured-default",
    },
  ])("returns a typed invalid outcome for $name", ({ facts, intent, reason }) => {
    expect(resolveHarnessSelection(facts, intent)).toEqual({ outcome: "invalid", reason });
  });

  it("does not let explicit input replace an unsupported configured default", () => {
    expect(
      resolveHarnessSelection(selectionFacts({ config: "custom", available: ["codex"] }), {
        kind: "explicit",
        harnessIds: ["codex"],
      }),
    ).toEqual({ outcome: "invalid", reason: "unsupported-configured-default" });
  });

  it("preserves cancellation", () => {
    expect(
      resolveHarnessSelection(selectionFacts({ config: "missing", available: ["codex"] }), {
        kind: "cancelled",
      }),
    ).toEqual({ outcome: "cancelled" });
  });
});

function selectionFacts(input: {
  config: "missing" | "invalid" | string;
  available: readonly CliSetupHarnessId[];
  order?: readonly CliSetupHarnessId[];
}): HarnessSelectionFacts {
  const order = input.order ?? harnessIds;
  const defaultHarness = CliSetupHarnessIdSchema.safeParse(input.config);
  const config: HarnessSelectionFacts["config"] =
    input.config === "missing"
      ? { status: "missing" }
      : input.config === "invalid"
        ? { status: "invalid" }
        : defaultHarness.success
          ? { status: "valid", defaultHarness: defaultHarness.data }
          : { status: "unsupported" };
  return {
    config,
    harnesses: order.map((id) => ({
      id,
      availability: input.available.includes(id) ? "available" : "unavailable",
    })),
  };
}
