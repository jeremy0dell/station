import { describe, expect, it } from "vitest";
import { parseGitWorktreeRemovalEvidence } from "../../src/removalEvidence";

describe("Git worktree removal evidence", () => {
  it("parses branches, detached heads, and prunable registrations", () => {
    const output = [
      "worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0",
      "worktree /repo/linked\0HEAD 2222222222222222222222222222222222222222\0detached\0\0",
      "worktree /repo/missing\0HEAD 3333333333333333333333333333333333333333\0branch refs/heads/missing\0prunable gitdir file points to non-existent location\0\0",
    ].join("");

    expect(parseGitWorktreeRemovalEvidence(output)).toEqual([
      { path: "/repo", branch: "main", state: "exists" },
      { path: "/repo/linked", branch: "detached:222222222222", state: "exists" },
      { path: "/repo/missing", branch: "missing", state: "missing" },
    ]);
  });

  it("rejects records without a worktree path", () => {
    expect(() =>
      parseGitWorktreeRemovalEvidence(
        "HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0",
      ),
    ).toThrow("could not safely revalidate");
  });

  it("rejects duplicate worktree fields in one record", () => {
    expect(() =>
      parseGitWorktreeRemovalEvidence(
        "worktree /one\0worktree /two\0HEAD 1111111111111111111111111111111111111111\0\0",
      ),
    ).toThrow("could not safely revalidate");
  });
});
