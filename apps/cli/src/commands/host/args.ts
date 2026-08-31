import type { HostHandoffFidelity } from "@station/contracts";

export type HostCommandAction = "status" | "handoff";

export type ParsedHostArgs = {
  action: HostCommandAction;
  dryRun: boolean;
  fidelity: HostHandoffFidelity;
  /** Selects the updater's idempotent exact-convergence projection. */
  updateCrossover: boolean;
  /** Preflight-only fact that the selected artifact will replace an exact incumbent. */
  replacementRequired: boolean;
};

export function parseHostArgs(args: readonly string[]): ParsedHostArgs {
  const tokens = [...args];
  const actionToken = tokens.shift();
  if (actionToken !== "status" && actionToken !== "handoff") {
    throw new Error(
      actionToken === undefined
        ? "Usage: stn host <status|handoff>"
        : `Unknown host command: ${actionToken}`,
    );
  }

  let dryRun = false;
  let fidelity: HostHandoffFidelity = "processes";
  let updateCrossover = false;
  let replacementRequired = false;
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === undefined) {
      break;
    }
    if (actionToken === "status") {
      throw new Error(`stn host status does not accept ${token}`);
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--update-crossover") {
      if (updateCrossover) throw new Error("Host update crossover may be selected only once.");
      updateCrossover = true;
      continue;
    }
    if (token === "--replacement-required") {
      if (replacementRequired) throw new Error("Host replacement may be required only once.");
      replacementRequired = true;
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

  if (replacementRequired && (!updateCrossover || !dryRun)) {
    throw new Error("Host replacement-required is valid only for update crossover dry-run.");
  }
  return {
    action: actionToken,
    dryRun,
    fidelity,
    updateCrossover,
    replacementRequired,
  };
}

function parseFidelity(value: string | undefined): HostHandoffFidelity {
  if (value !== "processes" && value !== "screen") {
    throw new Error("Usage: stn host handoff [--fidelity processes|screen]");
  }
  return value;
}
