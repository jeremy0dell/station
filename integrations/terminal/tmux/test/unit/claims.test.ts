import { describe, expect, it } from "vitest";
import { captureTmuxCallerClaims } from "../../src/placement/claims";

describe("tmux caller claim capture", () => {
  it("copies only the two tmux evidence fields", () => {
    expect(
      captureTmuxCallerClaims({
        TMUX: "/tmp/tmux.sock,10,0",
        TMUX_PANE: "%1",
        STATION_SECRET: "must-not-cross",
      }),
    ).toEqual({ TMUX: "/tmp/tmux.sock,10,0", TMUX_PANE: "%1" });
  });

  it("preserves absence for missing evidence", () => {
    expect(captureTmuxCallerClaims({})).toEqual({});
  });
});
