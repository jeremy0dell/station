import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { devHostSocketPath, devRenderProfilePath, devStateDir } from "./devPaths.js";

// devPaths resolves the worktree-local .dev-state relative to its own file URL, so
// the ../ depth is tied to this file's location under station/src/host/. Pin it to
// the repo root (three levels up) so a future move can't silently escape the worktree
// — exactly the regression the experimental/station -> station/ flatten introduced.
describe("devPaths", () => {
  const repoRootDevState = fileURLToPath(new URL("../../../.dev-state", import.meta.url));

  it("resolves dev state to the repo-root .dev-state", () => {
    expect(devStateDir()).toBe(repoRootDevState);
  });

  it("derives host socket and render profile paths under the same .dev-state", () => {
    expect(devHostSocketPath()).toBe(`${repoRootDevState}/run/station-host.sock`);
    expect(devRenderProfilePath()).toBe(`${repoRootDevState}/station-renders.jsonl`);
  });
});
