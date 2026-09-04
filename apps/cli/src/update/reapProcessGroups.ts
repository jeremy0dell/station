import type { UpdateReapJournalTarget } from "@station/contracts";
import { runExternalCommand } from "@station/runtime";

const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
const processLine = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u;

export type UpdateReapProcess = UpdateReapJournalTarget["processGroup"]["leader"];
export type UpdateReapProcessGroup = UpdateReapJournalTarget["processGroup"];
export type UpdateReapProcessGroupObservation = Readonly<{
  leader?: UpdateReapProcess;
  members: UpdateReapProcess[];
}>;

export class UpdateReapProcessGroupEvidenceError extends Error {
  override readonly name = "UpdateReapProcessGroupEvidenceError";
}

/**
 * DRIVEN PORT
 *
 * Supplies exact POSIX process-group evidence and the only signal capability used by update reap.
 */
export interface UpdateReapProcessGroupPort {
  read(pgid: number): Promise<UpdateReapProcessGroupObservation>;
  signal(pgid: number, signal: "SIGTERM" | "SIGKILL"): void;
  wait(milliseconds: number): Promise<void>;
}

/** Parses the fixed `ps pid,ppid,pgid,lstart` format used for process-group authorization. */
export function parseUpdateReapProcessLine(line: string): UpdateReapProcess {
  const match = processLine.exec(line);
  const pid = Number(match?.[1]);
  const parentPid = Number(match?.[2]);
  const pgid = Number(match?.[3]);
  const startToken = match?.[4]?.trim() ?? "";
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    !Number.isSafeInteger(pgid) ||
    pgid <= 0 ||
    startToken.length === 0
  ) {
    throw new Error("Process-group evidence was malformed.");
  }
  return { pid, parentPid, pgid, startToken };
}

export function updateReapProcessGroupsMatch(
  current: UpdateReapProcessGroupObservation,
  expected: UpdateReapProcessGroup,
): boolean {
  if (!updateReapProcessesMatch(current.leader, expected.leader)) {
    return false;
  }
  return (
    current.members.length === expected.members.length &&
    current.members.every((member, index) => {
      const candidate = expected.members[index];
      return candidate !== undefined && updateReapProcessesMatch(member, candidate);
    })
  );
}

export function updateReapProcessGroupIsAuthorizedRemainder(
  current: UpdateReapProcessGroupObservation,
  expected: UpdateReapProcessGroup,
): boolean {
  if (current.members.length === 0 || current.members.length > expected.members.length)
    return false;
  const leaderRemains = current.leader !== undefined;
  if (leaderRemains && !updateReapProcessesMatch(current.leader, expected.leader)) {
    return false;
  }
  if (!leaderRemains && current.members.some((member) => member.pid === expected.leader.pid)) {
    return false;
  }
  return current.members.every((member) => {
    const candidate = expected.members.find((expectedMember) => expectedMember.pid === member.pid);
    if (candidate === undefined) return false;
    return leaderRemains
      ? updateReapProcessesMatch(member, candidate)
      : updateReapProcessesMatch(member, {
          pid: candidate.pid,
          pgid: candidate.pgid,
          startToken: candidate.startToken,
        });
  });
}

export function exactUpdateReapProcessGroup(
  observation: UpdateReapProcessGroupObservation,
): UpdateReapProcessGroup | undefined {
  return observation.leader === undefined
    ? undefined
    : { leader: observation.leader, members: observation.members };
}

export function updateReapProcessesMatch(
  current: UpdateReapProcess | undefined,
  expected: Pick<UpdateReapProcess, "pid" | "startToken"> & Partial<UpdateReapProcess>,
): current is UpdateReapProcess {
  return (
    current !== undefined &&
    current.pid === expected.pid &&
    current.startToken === expected.startToken &&
    (expected.parentPid === undefined || current.parentPid === expected.parentPid) &&
    (expected.pgid === undefined || current.pgid === expected.pgid)
  );
}

export function updateReapProcessGroupPsArgs(): string[] {
  return ["-axww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart="];
}

/**
 * ADAPTER
 *
 * Reads the complete POSIX process table and signals one negative PGID only after policy has
 * accepted its exact identity.
 */
export function createPosixUpdateReapProcessGroupPort(
  run: typeof runExternalCommand = runExternalCommand,
): UpdateReapProcessGroupPort {
  return {
    async read(pgid) {
      const result = await run({
        command: psPath,
        args: updateReapProcessGroupPsArgs(),
        displayArgs: ["-axww", "-o", "pid,ppid,pgid,lstart"],
        env: { LC_ALL: "C" },
        maxOutputChars: 4 * 1024 * 1024,
      }).catch(() => {
        throw new UpdateReapProcessGroupEvidenceError(
          "The process-group evidence command could not run for update reap.",
        );
      });
      const { stdout, stderr } = result;
      if (stderr !== "") {
        throw new UpdateReapProcessGroupEvidenceError(
          "The process-group evidence command returned diagnostic output.",
        );
      }
      if (stdout === "") {
        throw new UpdateReapProcessGroupEvidenceError(
          "The process-group evidence command returned no process table.",
        );
      }
      if (stdout.includes("\r")) {
        throw new UpdateReapProcessGroupEvidenceError(
          "The process-group evidence command returned noncanonical line endings.",
        );
      }
      let processes: UpdateReapProcess[];
      try {
        processes = stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map(parseUpdateReapProcessLine);
      } catch {
        throw new UpdateReapProcessGroupEvidenceError(
          "The process-group evidence command returned a malformed process table.",
        );
      }
      const members = processes
        .filter((entry) => entry.pgid === pgid)
        .sort((left, right) => left.pid - right.pid);
      const leader = members.find((entry) => entry.pid === pgid);
      return { ...(leader === undefined ? {} : { leader }), members };
    },
    signal(pgid, signal) {
      if (!Number.isSafeInteger(pgid) || pgid <= 0) {
        throw new Error("Update reap refused an invalid process group.");
      }
      process.kill(-pgid, signal);
    },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}
