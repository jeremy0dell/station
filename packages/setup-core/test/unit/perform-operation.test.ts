import type {
  SetupOperation,
  SetupOperationOutcome,
  SetupOperationPorts,
} from "@station/setup-core";
import { performSetupOperation } from "@station/setup-core";
import { describe, expect, it, vi } from "vitest";

const completed = (operation: SetupOperation): SetupOperationOutcome => ({
  status: "completed",
  operationId: operation.id,
  commit: { kind: "launcher-link" },
});

function ports() {
  const config = vi.fn(async (operation) => completed(operation));
  const observer = vi.fn(async (operation) => completed(operation));
  const harnessTracking = vi.fn(async (operation) => completed(operation));
  const worktrunk = vi.fn(async (operation) => completed(operation));
  const tmux = vi.fn(async (operation) => completed(operation));
  const packages = vi.fn(async (operation) => completed(operation));
  const launchers = vi.fn(async (operation) => completed(operation));
  return {
    value: {
      config,
      observer,
      harnessTracking,
      worktrunk,
      tmux,
      packages,
      launchers,
    } satisfies SetupOperationPorts,
    spies: { config, observer, harnessTracking, worktrunk, tmux, packages, launchers },
  };
}

describe("performSetupOperation", () => {
  it.each([
    [writeConfigOperation(), "config"],
    [operation("activate-observer-config"), "observer"],
    [operation("prepare-harness-tracking"), "harnessTracking"],
    [operation("prepare-worktrunk-tracking"), "worktrunk"],
    [operation("configure-worktrunk-shell"), "worktrunk"],
    [operation("configure-tmux-popup"), "tmux"],
    [operation("install-tool"), "packages"],
    [operation("install-harness"), "packages"],
    [operation("install-homebrew"), "packages"],
    [operation("install-xcode-command-line-tools"), "packages"],
    [operation("link-launchers"), "launchers"],
  ] as const)("dispatches %s through its driven port", async (setupOperation, port) => {
    const setupPorts = ports();

    await expect(performSetupOperation(setupOperation, setupPorts.value)).resolves.toMatchObject({
      status: "completed",
      operationId: setupOperation.id,
    });

    expect(setupPorts.spies[port]).toHaveBeenCalledExactlyOnceWith(setupOperation);
    expect(Object.values(setupPorts.spies).filter((spy) => spy.mock.calls.length > 0)).toHaveLength(
      1,
    );
  });
});

function writeConfigOperation(): Extract<SetupOperation, { kind: "write-config" }> {
  return {
    id: "write-config",
    kind: "write-config",
    tier: "required",
    selected: true,
    change: "create",
    defaultHarnessId: "codex",
    harnessIds: ["codex"],
    trackingHarnessIds: ["codex"],
    installWorktrunkTracking: false,
  };
}

function operation(kind: Exclude<SetupOperation["kind"], "write-config">): SetupOperation {
  switch (kind) {
    case "activate-observer-config":
      return { id: kind, kind, tier: "required", selected: true };
    case "prepare-harness-tracking":
      return {
        id: "prepare-harness-tracking:codex",
        kind,
        tier: "required",
        selected: true,
        harnessId: "codex",
      };
    case "prepare-worktrunk-tracking":
      return { id: kind, kind, tier: "recommended", selected: true };
    case "configure-worktrunk-shell":
      return { id: kind, kind, tier: "recommended", selected: false };
    case "configure-tmux-popup":
      return {
        id: "persist-tmux-popup",
        kind,
        tier: "recommended",
        selected: false,
        scope: "persisted",
      };
    case "install-tool":
      return {
        id: "install:tmux",
        kind,
        tier: "required",
        selected: true,
        tool: "tmux",
      };
    case "install-harness":
      return {
        id: "install-harness:codex",
        kind,
        tier: "required",
        selected: true,
        harnessId: "codex",
      };
    case "install-homebrew":
      return { id: "install:homebrew", kind, tier: "required", selected: true };
    case "install-xcode-command-line-tools":
      return {
        id: "install:xcode-command-line-tools",
        kind,
        tier: "required",
        selected: true,
      };
    case "link-launchers":
      return {
        id: "link-station-launchers",
        kind,
        tier: "recommended",
        selected: false,
      };
  }
}
