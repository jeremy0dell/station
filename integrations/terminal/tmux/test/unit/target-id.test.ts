import { describe, expect, it } from "vitest";
import { buildTmuxTargetId, parseTmuxTargetId } from "../../src/targetId";

const generation = "a".repeat(64);

describe("tmux target identity", () => {
  it("round-trips generation-qualified provider target IDs", () => {
    const id = buildTmuxTargetId({
      generation,
      sessionId: "$1",
      windowId: "@12",
      paneId: "%34",
    });

    expect(id).toBe(`tmux:${generation}:$1:@12:%34`);
    expect(parseTmuxTargetId(id)).toEqual({
      generation,
      sessionId: "$1",
      windowId: "@12",
      paneId: "%34",
    });
  });

  it("rejects unqualified, malformed, and non-generation identities", () => {
    expect(() => parseTmuxTargetId("tmux:station:@12:%34")).toThrow(
      "Invalid tmux target identity.",
    );
    expect(() => parseTmuxTargetId("tmux:not-a-generation:$1:@12:%34")).toThrow(
      "Invalid tmux target identity.",
    );
    expect(() => parseTmuxTargetId(`tmux:${generation}:station:12:34`)).toThrow(
      "Invalid tmux target identity.",
    );
  });
});
