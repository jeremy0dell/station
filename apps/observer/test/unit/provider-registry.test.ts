import {
  FakeHarnessProvider,
  FakeTerminalPlacementPort,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/providers/registry.js";

describe("ProviderRegistry terminal placement roles", () => {
  it("keeps ordinary-only terminals registered without pretending placement support", () => {
    const terminal = new FakeTerminalProvider();
    const registry = registryWith(terminal);

    expect(registry.terminals.get(terminal.id)).toBe(terminal);
    expect(registry.terminalPlacements.size).toBe(0);
  });

  it("registers a matching explicit placement role", () => {
    const terminal = new FakeTerminalProvider();
    const registry = registryWith(terminal, [terminal.placement]);

    expect(registry.terminalPlacements.get(terminal.id)).toBe(terminal.placement);
    expect(terminal.placement.supportedIntents).toEqual(["sibling", "detached"]);
  });

  it("rejects placement without a matching terminal and duplicate placement ids", () => {
    const terminal = new FakeTerminalProvider();
    const otherTerminal = new FakeTerminalProvider({ id: "other-terminal" });
    const unmatched = new FakeTerminalPlacementPort(otherTerminal);

    expect(() => registryWith(terminal, [unmatched])).toThrow(
      "Terminal placement provider has no matching terminal provider: other-terminal",
    );
    expect(() => registryWith(terminal, [terminal.placement, terminal.placement])).toThrow(
      "Duplicate terminal placement provider id: fake-terminal",
    );
  });
});

function registryWith(
  terminal: FakeTerminalProvider,
  terminalPlacements: FakeTerminalPlacementPort[] = [],
) {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider(),
    terminal,
    terminalPlacements,
    harnesses: [new FakeHarnessProvider()],
  });
}
