import { execFileSync } from "node:child_process";

const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u;
const maximumDefaultAncestryDepth = 16;
const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";

export type ProcessIdentity = {
  pid: number;
  startToken: string;
};

export type ProcessEvidenceEntry = ProcessIdentity & {
  parentPid: number;
};

export type ProcessEvidence = {
  read(pid: number): ProcessEvidenceEntry | undefined;
};

/** Parses the deliberately minimal `ps pid,ppid,lstart` evidence format. */
export function parseProcessEvidenceLine(line: string): ProcessEvidenceEntry {
  const match = PROCESS_LINE.exec(line);
  if (match === null) throw new Error("Process evidence was malformed.");
  const pid = Number(match?.[1]);
  const parentPid = Number(match?.[2]);
  const startToken = match?.[3]?.trim() ?? "";
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    startToken.length === 0
  ) {
    throw new Error("Process evidence was invalid.");
  }
  return { pid, parentPid, startToken };
}

/** Strict local process reader used only at provider boundaries. */
export function createLocalProcessEvidence(
  execute: (pid: number) => string = (pid) =>
    execFileSync(psPath, ["-ww", "-p", String(pid), "-o", "pid=,ppid=,lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }),
): ProcessEvidence {
  return {
    read(pid) {
      try {
        const lines = execute(pid)
          .split("\n")
          .filter((line) => line.trim().length > 0);
        if (lines.length !== 1) {
          throw new Error("Process evidence did not identify exactly one process.");
        }
        const line = lines[0];
        if (line === undefined) {
          throw new Error("Process evidence did not return a process.");
        }
        const entry = parseProcessEvidenceLine(line);
        return entry.pid === pid ? entry : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export function processIdentityMatches(
  current: ProcessEvidenceEntry | undefined,
  expected: ProcessIdentity,
): current is ProcessEvidenceEntry {
  return current?.pid === expected.pid && current.startToken === expected.startToken;
}

/**
 * Re-reads every ancestor, rejects cycles, and bounds traversal so a claimed
 * terminal can never be accepted through stale PID or unbounded ancestry data.
 */
export function processDescendsFrom(
  evidence: ProcessEvidence,
  caller: ProcessIdentity,
  ancestor: number | ProcessIdentity,
  options: { maxDepth?: number } = {},
): boolean {
  const maxDepth = options.maxDepth ?? maximumDefaultAncestryDepth;
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) return false;
  const first = evidence.read(caller.pid);
  if (!processIdentityMatches(first, caller)) return false;
  const ancestorPid = typeof ancestor === "number" ? ancestor : ancestor.pid;

  let current = first;
  const visited = new Set<number>();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (current.pid === ancestorPid) {
      return typeof ancestor === "number" || processIdentityMatches(current, ancestor);
    }
    if (current.parentPid <= 0 || visited.has(current.pid)) return false;
    visited.add(current.pid);
    const parent = evidence.read(current.parentPid);
    if (parent === undefined || parent.pid !== current.parentPid) return false;
    current = parent;
  }
  return false;
}

export const DEFAULT_PROCESS_ANCESTRY_DEPTH = maximumDefaultAncestryDepth;
