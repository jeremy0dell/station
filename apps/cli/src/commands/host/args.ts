import type { HostHandoffFidelity } from "@station/contracts";

export type HostCommandAction = "status" | "handoff" | "update-converge";

export type ParsedHostArgs =
  | { action: "status"; output: "text" }
  | {
      action: "handoff";
      dryRun: boolean;
      fidelity: HostHandoffFidelity;
      output: "text" | "json";
    }
  | { action: "update-converge"; output: "json"; stdin: true };

export function parseHostArgs(args: readonly string[]): ParsedHostArgs {
  const tokens = [...args];
  const actionToken = tokens.shift();
  if (actionToken !== "status" && actionToken !== "handoff" && actionToken !== "update-converge") {
    throw new Error(
      actionToken === undefined
        ? "Usage: stn host <status|handoff>"
        : `Unknown host command: ${actionToken}`,
    );
  }

  if (actionToken === "update-converge") {
    if (tokens.length !== 2 || !tokens.includes("--stdin") || !tokens.includes("--json")) {
      throw new Error("Usage: stn host update-converge --stdin --json");
    }
    return { action: "update-converge", output: "json", stdin: true };
  }

  let dryRun = false;
  let fidelity: HostHandoffFidelity = "processes";
  let output: "text" | "json" = "text";
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === undefined) {
      break;
    }
    if (actionToken === "status") {
      throw new Error(`stn host status does not accept ${token}`);
    }
    if (token === "--json") {
      output = "json";
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--fidelity") {
      const value = tokens.shift();
      fidelity = parseFidelity(value);
      continue;
    }
    if (token.startsWith("--fidelity=")) {
      fidelity = parseFidelity(token.slice("--fidelity=".length));
      continue;
    }
    throw new Error(`Unknown host flag: ${token}`);
  }

  return actionToken === "status"
    ? { action: "status", output: "text" }
    : { action: "handoff", dryRun, fidelity, output };
}

function parseFidelity(value: string | undefined): HostHandoffFidelity {
  if (value !== "processes" && value !== "screen") {
    throw new Error("Usage: stn host handoff [--fidelity processes|screen] [--json]");
  }
  return value;
}
