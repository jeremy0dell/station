import {
  appendObserverEventHookBlock,
  removeObserverEventHookBlocksByIdPredicate,
} from "@station/config";
import { describe, expect, it } from "vitest";

describe("observer event hook TOML blocks", () => {
  it("appends an observer event hook block with stable spacing", () => {
    const source = ["schema_version = 1", "projects = []", ""].join("\n");

    const result = appendObserverEventHookBlock(
      source,
      [
        "[[hooks.event]]",
        'id = "notify-agent-state"',
        'events = ["worktree.agentStateChanged"]',
      ].join("\n"),
    );

    expect(result).toBe(
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[[hooks.event]]",
        'id = "notify-agent-state"',
        'events = ["worktree.agentStateChanged"]',
        "",
      ].join("\n"),
    );
  });

  it("removes observer event hook blocks selected by id predicate", () => {
    const source = [
      "schema_version = 1",
      "",
      "[[hooks.event]]",
      'id = "notify-agent-state"',
      'command = "stn"',
      "",
      "[[hooks.event]]",
      'id = "notify-agent-stale"',
      'command = "osascript"',
      "",
      "[[hooks.event]]",
      'id = "keep-me"',
      'command = "stn"',
      "",
    ].join("\n");

    const result = removeObserverEventHookBlocksByIdPredicate(source, (hookId) =>
      hookId.startsWith("notify-agent-"),
    );

    expect(result).toBe(
      ["schema_version = 1", "", "[[hooks.event]]", 'id = "keep-me"', 'command = "stn"'].join("\n"),
    );
  });
});
