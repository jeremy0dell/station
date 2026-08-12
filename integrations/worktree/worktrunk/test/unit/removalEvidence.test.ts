import { describe, expect, it } from "vitest";
import {
  parseGitCheckoutRemovalIdentity,
  parseGitCommonDirectory,
  parseGitWorktreeRemovalEvidence,
} from "../../src/removalEvidence";

describe("Git worktree removal evidence", () => {
  it("parses targeted checkout and project identity", () => {
    expect(
      parseGitCheckoutRemovalIdentity(
        "/repo/linked\n/repo/.git\n1111111111111111111111111111111111111111\nrefs/heads/feature\n",
      ),
    ).toEqual({
      path: "/repo/linked",
      commonDir: "/repo/.git",
      headSha: "1111111111111111111111111111111111111111",
      branch: "feature",
    });
    expect(
      parseGitCheckoutRemovalIdentity(
        "/repo/linked\n/repo/.git\n2222222222222222222222222222222222222222\nHEAD\n",
      ).branch,
    ).toBe("detached:222222222222");
    expect(parseGitCommonDirectory("/repo/.git\n")).toBe("/repo/.git");
  });

  it("parses branches, detached heads, and prunable registrations", () => {
    const output = [
      "worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0",
      "worktree /repo/linked\0HEAD 2222222222222222222222222222222222222222\0detached\0\0",
      "worktree /repo/missing\0HEAD 3333333333333333333333333333333333333333\0branch refs/heads/missing\0prunable gitdir file points to non-existent location\0\0",
    ].join("");

    expect(parseGitWorktreeRemovalEvidence(output)).toEqual([
      {
        path: "/repo",
        headSha: "1111111111111111111111111111111111111111",
        branch: "main",
        state: "exists",
        isPrimaryCheckout: true,
      },
      {
        path: "/repo/linked",
        headSha: "2222222222222222222222222222222222222222",
        branch: "detached:222222222222",
        state: "exists",
        isPrimaryCheckout: false,
      },
      {
        path: "/repo/missing",
        headSha: "3333333333333333333333333333333333333333",
        branch: "missing",
        state: "missing",
        isPrimaryCheckout: false,
      },
    ]);
  });

  it("rejects incomplete records", () => {
    expect(() =>
      parseGitWorktreeRemovalEvidence("worktree /repo\0branch refs/heads/main\0\0"),
    ).toThrow("could not safely revalidate");
    expect(() =>
      parseGitWorktreeRemovalEvidence(
        "HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0",
      ),
    ).toThrow("could not safely revalidate");
    expect(() =>
      parseGitWorktreeRemovalEvidence("worktree /repo\0HEAD not-a-sha\0branch refs/heads/main\0\0"),
    ).toThrow("could not safely revalidate");
    expect(() =>
      parseGitCheckoutRemovalIdentity("/repo\n/repo/.git\nnot-a-sha\nrefs/heads/main\n"),
    ).toThrow("could not safely revalidate");
    expect(() => parseGitCommonDirectory("/one\n/two\n")).toThrow("could not safely revalidate");
  });

  it("rejects duplicate identity fields", () => {
    expect(() =>
      parseGitWorktreeRemovalEvidence(
        "worktree /one\0worktree /two\0HEAD 1111111111111111111111111111111111111111\0\0",
      ),
    ).toThrow("could not safely revalidate");
    expect(() =>
      parseGitWorktreeRemovalEvidence(
        "worktree /one\0HEAD 1111111111111111111111111111111111111111\0HEAD 2222222222222222222222222222222222222222\0\0",
      ),
    ).toThrow("could not safely revalidate");
  });
});
