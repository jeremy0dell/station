import { RepairSha256Schema } from "@station/contracts";
import type { RepairSelector } from "../../repair/plan.js";

export type RepairRequest =
  | { kind: "inventory"; output: "text" | "json" }
  | {
      kind: "action";
      selector: RepairSelector;
      mode: "preview" | "apply";
      output: "text" | "json";
      expectedPlanDigest?: string;
    };

const usage =
  "Usage: stn repair inventory [--json] | stn repair terminal reap --terminal <terminalTargetId> [--json] [--yes --expect-plan <sha256>] | stn repair observer cleanup [--json] [--yes --expect-plan <sha256>] | stn repair recovery <resume|prune> --handle <recoveryHandleId> [--json] [--yes --expect-plan <sha256>]";

export function parseRepairRequest(args: readonly string[]): RepairRequest {
  if (args.length === 0) throw new Error(usage);
  const path = actionPath(args);
  const options = args.slice(path.consumed);
  let output: "text" | "json" = "text";
  let yes = false;
  let expectedPlanDigest: string | undefined;
  let terminalTargetId: string | undefined;
  let recoveryHandleId: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--json" && output === "text") {
      output = "json";
      continue;
    }
    if (option === "--yes" && !yes) {
      yes = true;
      continue;
    }
    if (option === "--expect-plan" && expectedPlanDigest === undefined) {
      const value = options[index + 1];
      if (!RepairSha256Schema.safeParse(value).success) throw new Error(usage);
      expectedPlanDigest = value;
      index += 1;
      continue;
    }
    if (option === "--terminal" && terminalTargetId === undefined) {
      terminalTargetId = requireValue(options[index + 1]);
      index += 1;
      continue;
    }
    if (option === "--handle" && recoveryHandleId === undefined) {
      recoveryHandleId = requireValue(options[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(usage);
  }
  if (path.kind === "inventory") {
    if (yes || expectedPlanDigest !== undefined || terminalTargetId || recoveryHandleId) {
      throw new Error(usage);
    }
    return { kind: "inventory", output };
  }
  if (yes !== (expectedPlanDigest !== undefined)) throw new Error(usage);
  let selector: RepairSelector;
  if (path.kind === "terminal-reap") {
    if (terminalTargetId === undefined || recoveryHandleId !== undefined) throw new Error(usage);
    selector = { kind: path.kind, terminalTargetId };
  } else if (path.kind === "observer-cleanup") {
    if (terminalTargetId !== undefined || recoveryHandleId !== undefined) throw new Error(usage);
    selector = { kind: path.kind };
  } else {
    if (recoveryHandleId === undefined || terminalTargetId !== undefined) throw new Error(usage);
    selector = { kind: path.kind, recoveryHandleId };
  }
  return {
    kind: "action",
    selector,
    mode: yes ? "apply" : "preview",
    output,
    ...(expectedPlanDigest === undefined ? {} : { expectedPlanDigest }),
  };
}

function actionPath(args: readonly string[]):
  | { kind: "inventory"; consumed: 1 }
  | {
      kind: "terminal-reap" | "observer-cleanup" | "recovery-resume" | "recovery-prune";
      consumed: 2;
    } {
  if (args[0] === "inventory") return { kind: "inventory", consumed: 1 };
  if (args[0] === "terminal" && args[1] === "reap") return { kind: "terminal-reap", consumed: 2 };
  if (args[0] === "observer" && args[1] === "cleanup") {
    return { kind: "observer-cleanup", consumed: 2 };
  }
  if (args[0] === "recovery" && args[1] === "resume") {
    return { kind: "recovery-resume", consumed: 2 };
  }
  if (args[0] === "recovery" && args[1] === "prune") {
    return { kind: "recovery-prune", consumed: 2 };
  }
  throw new Error(usage);
}

function requireValue(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error(usage);
  return value;
}
