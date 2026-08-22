import {
  createLocalProcessEvidence,
  type ProcessEvidence,
  parseProcessEvidenceLine,
  processDescendsFrom,
} from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("process evidence", () => {
  it("executes one bounded read for the requested process", () => {
    const calls: number[] = [];
    const evidence = createLocalProcessEvidence((pid) => {
      calls.push(pid);
      return `${pid} 7 Tue Aug 20 12:00:00 2026\n`;
    });

    expect(evidence.read(42)).toEqual({
      pid: 42,
      parentPid: 7,
      startToken: "Tue Aug 20 12:00:00 2026",
    });
    expect(calls).toEqual([42]);
  });

  it("parses a strict PID/parent/start-token record", () => {
    expect(parseProcessEvidenceLine(" 42 7 Tue Aug 20 12:00:00 2026 ")).toEqual({
      pid: 42,
      parentPid: 7,
      startToken: "Tue Aug 20 12:00:00 2026",
    });
    expect(() => parseProcessEvidenceLine("42 7")).toThrow("malformed");
  });

  it("requires fresh caller identity and rejects ancestry cycles", () => {
    const records = new Map([
      [20, { pid: 20, parentPid: 10, startToken: "caller" }],
      [10, { pid: 10, parentPid: 1, startToken: "shell" }],
      [1, { pid: 1, parentPid: 1, startToken: "init" }],
    ]);
    const evidence: ProcessEvidence = { read: (pid) => records.get(pid) };
    expect(processDescendsFrom(evidence, { pid: 20, startToken: "caller" }, 10)).toBe(true);
    expect(
      processDescendsFrom(
        evidence,
        { pid: 20, startToken: "caller" },
        { pid: 10, startToken: "shell" },
      ),
    ).toBe(true);
    expect(
      processDescendsFrom(
        evidence,
        { pid: 20, startToken: "caller" },
        { pid: 10, startToken: "reused" },
      ),
    ).toBe(false);
    expect(processDescendsFrom(evidence, { pid: 20, startToken: "reused" }, 10)).toBe(false);
    expect(processDescendsFrom(evidence, { pid: 20, startToken: "caller" }, 99)).toBe(false);
  });

  it("bounds ancestry reads and rejects depth exhaustion", () => {
    let reads = 0;
    const evidence: ProcessEvidence = {
      read: (pid) => {
        reads += 1;
        return { pid, parentPid: pid - 1, startToken: pid === 20 ? "caller" : `process-${pid}` };
      },
    };

    expect(
      processDescendsFrom(evidence, { pid: 20, startToken: "caller" }, 1, { maxDepth: 3 }),
    ).toBe(false);
    expect(reads).toBe(4);
  });
});
