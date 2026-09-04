import { describe, expect, it } from "vitest";
import {
  createPosixUpdateReapProcessGroupPort,
  exactUpdateReapProcessGroup,
  parseUpdateReapProcessLine,
  updateReapProcessGroupIsAuthorizedRemainder,
  updateReapProcessGroupPsArgs,
  updateReapProcessGroupsMatch,
} from "../../src/update/reapProcessGroups.js";

const leader = {
  pid: 200,
  parentPid: 100,
  pgid: 200,
  startToken: "Mon Jan  1 00:00:00 2024",
};

describe("update reap process groups", () => {
  it("reports malformed process tables without exposing their contents", async () => {
    const port = createPosixUpdateReapProcessGroupPort(async (input) => ({
      command: input.command,
      args: input.args ?? [],
      stdout: "private process text\n",
      stderr: "",
      exitCode: 0,
    }));

    await expect(port.read(42)).rejects.toThrow(
      "The process-group evidence command returned a malformed process table.",
    );
  });

  it("uses separate portable ps output fields for the complete process table", () => {
    expect(updateReapProcessGroupPsArgs()).toEqual([
      "-axww",
      "-o",
      "pid=",
      "-o",
      "ppid=",
      "-o",
      "pgid=",
      "-o",
      "lstart=",
    ]);
  });

  it("parses the exact POSIX process evidence format", () => {
    expect(parseUpdateReapProcessLine(" 200 100 200 Mon Jan  1 00:00:00 2024")).toEqual(leader);
    expect(() => parseUpdateReapProcessLine("200 100 not-a-pgid token")).toThrow();
  });

  it("requires the leader and complete ordered membership to remain exact", () => {
    const expected = {
      leader,
      members: [leader, { ...leader, pid: 201, parentPid: 200 }],
    };
    expect(updateReapProcessGroupsMatch(structuredClone(expected), expected)).toBe(true);
    expect(updateReapProcessGroupsMatch({ ...expected, members: [leader] }, expected)).toBe(false);
    expect(
      updateReapProcessGroupsMatch(
        { ...expected, leader: { ...leader, startToken: "changed" } },
        expected,
      ),
    ).toBe(false);
  });

  it("admits an authorized member reparented after the group leader exits", () => {
    const child = { ...leader, pid: 201, parentPid: 200 };
    const expected = { leader, members: [leader, child] };
    expect(
      updateReapProcessGroupIsAuthorizedRemainder(
        { members: [{ ...child, parentPid: 1 }] },
        expected,
      ),
    ).toBe(true);
    expect(
      updateReapProcessGroupIsAuthorizedRemainder(
        { members: [{ ...child, startToken: "changed" }] },
        expected,
      ),
    ).toBe(false);
    expect(exactUpdateReapProcessGroup({ members: [child] })).toBeUndefined();
  });

  it("requires the authorized parent while the group leader remains", () => {
    const child = { ...leader, pid: 201, parentPid: 200 };
    const expected = { leader, members: [leader, child] };
    expect(
      updateReapProcessGroupIsAuthorizedRemainder(
        { leader, members: [leader, { ...child, parentPid: 1 }] },
        expected,
      ),
    ).toBe(false);
  });
});
