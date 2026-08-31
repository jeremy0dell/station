import type { HostCommandResult } from "./runHostCommand.js";

export function hostCommandSummary(result: HostCommandResult): string {
  if (result.action === "status") {
    const lines = [`socket: ${result.socketPath}`, `probe: ${result.probe}`];
    if (result.health !== undefined)
      lines.push(
        `health: ok protocol=${result.health.protocolVersion} build=${result.health.buildVersion}`,
      );
    if (result.compatibility !== undefined)
      lines.push(`compatibility: ${result.compatibility.action}`);
    if (result.livePtyCount !== undefined) lines.push(`livePtys: ${result.livePtyCount}`);
    if (result.handoffEligible !== undefined)
      lines.push(`handoffEligible: ${result.handoffEligible}`);
    if (result.error !== undefined) lines.push(`error: ${result.error}`);
    return `${lines.join("\n")}\n`;
  }
  const lines = [
    `handoff: ${result.status}`,
    `fidelity: ${result.fidelity}`,
    `dryRun: ${result.dryRun}`,
    `socket: ${result.socketPath}`,
    result.message,
  ];
  if (result.livePtyCount !== undefined) lines.push(`livePtys: ${result.livePtyCount}`);
  if (result.adopted !== undefined) lines.push(`adopted: ${result.adopted.length}`);
  return `${lines.join("\n")}\n`;
}
