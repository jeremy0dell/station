import type { StationConfig } from "@station/config";
import { parseStationObserverBuildVersion } from "@station/runtime";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import { createObserverCore, ProviderRegistry } from "../../src/internal.js";

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [],
};

describe("observer build version", () => {
  it("uses the display version while retaining the direct-construction fallback", () => {
    const buildVersion = `1.2.3+station.${"a".repeat(64)}`;
    const supplied = createObserverCore({
      config,
      providers: providers(),
      version: parseStationObserverBuildVersion(buildVersion).version,
    });
    const fallback = createObserverCore({ config, providers: providers() });

    expect(supplied.getSnapshot().observer.version).toBe("1.2.3");
    expect(fallback.getSnapshot().observer.version).toBe("0.0.0");
  });
});

function providers(): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider(),
    terminal: new FakeTerminalProvider(),
    harnesses: [new FakeHarnessProvider()],
  });
}
