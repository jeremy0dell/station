import { describe, expect, it } from "vitest";
import { TmuxPlacementAuthorityStore } from "../../src/placement/authority.js";
import type { TmuxPrivateProof } from "../../src/placement/types.js";

const proof: TmuxPrivateProof = {
  socketPath: "/tmp/station.sock",
  socket: { device: "1", inode: "2" },
  serverProcess: { pid: 10, startToken: "server" },
  sessionId: "$1",
  sessionName: "caller",
  windowId: "@1",
  paneId: "%1",
  panePid: 100,
  paneProcess: { pid: 100, startToken: "pane" },
  generation: "generation",
  targetId: "tmux:generation:$1:@1:%1",
};

describe("TmuxPlacementAuthorityStore", () => {
  it("expires entries and consumes a valid authority exactly once", () => {
    let now = new Date("2026-08-20T12:00:00.000Z");
    const store = new TmuxPlacementAuthorityStore({
      now: () => now,
      newId: () => "authority_1",
    });

    const authority = store.issue(proof, 60_000);
    expect(store.get(authority.id)?.value).toBe(proof);
    expect(store.consume(authority.id)?.value).toBe(proof);
    expect(store.consume(authority.id)).toBeUndefined();

    const expiring = store.issue(proof, 60_000);
    now = new Date("2026-08-20T12:01:00.000Z");
    expect(store.get(expiring.id)).toBeUndefined();
  });

  it("evicts the oldest live entry at bounded capacity", () => {
    let sequence = 0;
    const store = new TmuxPlacementAuthorityStore({
      capacity: 2,
      newId: () => `authority_${++sequence}`,
    });

    const first = store.issue(proof, 60_000);
    const second = store.issue(proof, 60_000);
    const third = store.issue(proof, 60_000);

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)?.value).toBe(proof);
    expect(store.get(third.id)?.value).toBe(proof);
  });
});
