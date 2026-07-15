import type { HarnessRunObservation, TerminalTargetObservation } from "@station/contracts";

type ActivationTerminal = Pick<TerminalTargetObservation, "harnessRunId" | "sessionId" | "state">;

type ActivationRun = Pick<HarnessRunObservation, "id" | "sessionId" | "state">;

/** Returns whether a reachable terminal's resolved run binding agrees with its Station session. */
export function terminalCanActivateSession(input: {
  target: ActivationTerminal;
  runs: readonly ActivationRun[];
}): boolean {
  const { target } = input;
  if (target.sessionId === undefined || (target.state !== "open" && target.state !== "detached")) {
    return false;
  }
  if (target.harnessRunId === undefined) return true;
  const boundRun = input.runs.find((run) => run.id === target.harnessRunId);
  return boundRun === undefined || boundRun.sessionId === target.sessionId;
}

/** Returns whether current run or matching terminal evidence can activate Station membership. */
export function harnessRunCanActivateSession(input: {
  run: ActivationRun;
  terminals: readonly ActivationTerminal[];
  runs: readonly ActivationRun[];
}): boolean {
  const correlatedTerminals = input.terminals.filter((target) =>
    terminalIsCorrelatedToRun(target, input.run),
  );
  if (
    input.run.state === "starting" ||
    input.run.state === "idle" ||
    input.run.state === "working" ||
    input.run.state === "needs_attention" ||
    input.run.state === "stuck"
  ) {
    if (correlatedTerminals.length === 0) return true;
    return correlatedTerminals.some((target) => terminalCanCorroborateRun(target, input.run));
  }

  const sessionId = input.run.sessionId;
  if (sessionId === undefined) return false;
  return input.terminals.some(
    (target) =>
      terminalCanCorroborateRun(target, input.run) ||
      (target.harnessRunId === undefined &&
        terminalCanActivateSession({ target, runs: input.runs }) &&
        target.sessionId === sessionId),
  );
}

function terminalCanCorroborateRun(target: ActivationTerminal, run: ActivationRun): boolean {
  return (
    terminalIsCorrelatedToRun(target, run) &&
    (target.state === "open" || target.state === "detached") &&
    (target.sessionId === undefined || target.sessionId === run.sessionId)
  );
}

function terminalIsCorrelatedToRun(target: ActivationTerminal, run: ActivationRun): boolean {
  return (
    target.harnessRunId === run.id ||
    (target.harnessRunId === undefined &&
      target.sessionId !== undefined &&
      target.sessionId === run.sessionId)
  );
}
