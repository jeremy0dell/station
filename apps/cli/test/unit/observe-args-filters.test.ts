import type { StationEvent } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { parseObserveArgs } from "../../src/commands/observe/args.js";
import {
  observeEventMatches,
  observeProtocolFilter,
  selectedProtocolTypes,
} from "../../src/commands/observe/filters.js";

describe("observe args and filters", () => {
  it("parses composable stream controls, category selectors, and identity selectors", () => {
    expect(
      parseObserveArgs([
        "--json",
        "--include-snapshot",
        "--agent",
        "--failed",
        "--type",
        "provider.healthChanged,observer.reconciled",
        "--trace",
        "trc_1",
        "--command",
        "cmd_1",
        "--limit",
        "2",
        "--duration",
        "500ms",
      ]),
    ).toEqual({
      json: true,
      pane: false,
      includeSnapshot: true,
      agent: true,
      failed: true,
      types: ["provider.healthChanged", "observer.reconciled"],
      traceId: "trc_1",
      commandId: "cmd_1",
      limit: 2,
      durationMs: 500,
    });
  });

  it("validates observe flags with stable messages", () => {
    expect(() => parseObserveArgs(["--bogus"])).toThrow("Unknown observe option: --bogus");
    expect(() => parseObserveArgs(["--trace"])).toThrow("--trace requires a value.");
    expect(() => parseObserveArgs(["--type", ","])).toThrow(
      "--type requires at least one event type.",
    );
    expect(() => parseObserveArgs(["--type", "not.real"])).toThrow(
      "Invalid observe event type: not.real.",
    );
    expect(() => parseObserveArgs(["--limit", "-1"])).toThrow(
      "--limit must be a non-negative integer.",
    );
    expect(() => parseObserveArgs(["--duration", "0s"])).toThrow(
      "--duration must be a positive duration like 500ms, 30s, or 5m.",
    );
    expect(() => parseObserveArgs(["--command", ""])).toThrow("Invalid observe command id: .");
    expect(() => parseObserveArgs(["--json", "--pane"])).toThrow(
      "--pane cannot be combined with --json.",
    );
  });

  it("builds additive category protocol filters and identity narrowing", () => {
    const parsed = parseObserveArgs(["--agent", "--failed", "--trace", "trc_1"]);

    expect(selectedProtocolTypes(parsed)).toEqual([
      "worktree.agentStateChanged",
      "session.created",
      "session.updated",
      "session.removed",
      "command.failed",
      "provider.healthChanged",
    ]);
    expect(observeProtocolFilter(parsed)).toEqual({
      type: [
        "worktree.agentStateChanged",
        "session.created",
        "session.updated",
        "session.removed",
        "command.failed",
        "provider.healthChanged",
      ],
      traceId: "trc_1",
    });
  });

  it("selects unhealthy provider changes for --failed but preserves explicit type selection", () => {
    const failed = parseObserveArgs(["--failed"]);
    const explicit = parseObserveArgs(["--type", "provider.healthChanged", "--failed"]);
    const healthyProviderEvent = providerEvent("healthy");

    expect(observeEventMatches(failed, healthyProviderEvent)).toBe(false);
    expect(observeEventMatches(explicit, healthyProviderEvent)).toBe(true);
    expect(observeEventMatches(failed, providerEvent("degraded"))).toBe(true);
  });

  it("narrows traced events after category selection", () => {
    const parsed = parseObserveArgs(["--agent", "--trace", "trc_1"]);

    expect(
      observeEventMatches(parsed, {
        type: "worktree.agentStateChanged",
        worktreeId: "wt_1",
      }),
    ).toBe(false);
    expect(
      observeEventMatches(parsed, {
        type: "command.failed",
        commandId: "cmd_1",
        traceId: "trc_1",
        error: {
          tag: "CommandError",
          code: "COMMAND_FAILED",
          message: "failed",
        },
      }),
    ).toBe(false);
  });
});

function providerEvent(status: "healthy" | "degraded"): StationEvent {
  return {
    type: "provider.healthChanged",
    provider: "codex",
    health: {
      providerId: "codex",
      providerType: "harness",
      status,
      lastCheckedAt: "2026-06-05T12:00:00.000Z",
    },
  };
}
