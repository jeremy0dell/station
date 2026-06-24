import type { HarnessLaunchPlan, TerminalLaunchProcessRequest } from "@station/contracts";
import { z } from "zod";
import { shellQuote } from "./shell.js";

export const TmuxLaunchPaneProviderDataSchema = z
  .object({
    paneTarget: z.string().min(1),
  })
  .passthrough();

export type BuildRespawnPaneLaunchArgsInput = {
  paneTarget: string;
  plan: HarnessLaunchPlan;
  cwdFallback: string;
};

export function buildRespawnPaneLaunchArgs(input: BuildRespawnPaneLaunchArgsInput): string[] {
  const cwd = input.plan.cwd ?? input.cwdFallback;
  const args = ["respawn-pane", "-k", "-t", input.paneTarget, "-c", cwd];
  for (const [key, value] of Object.entries(input.plan.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(renderLaunchCommand(input.plan));
  return args;
}

export function resolveLaunchPaneTarget(request: TerminalLaunchProcessRequest): string {
  const providerData = TmuxLaunchPaneProviderDataSchema.safeParse(
    request.terminalTarget.providerData,
  );
  return providerData.success ? providerData.data.paneTarget : request.agentEndpointId;
}

function renderLaunchCommand(plan: HarnessLaunchPlan): string {
  const args = plan.args.map(quoteArg);
  return [quoteCommand(plan.command), ...args].join(" ");
}

// Commands and args have different safe character sets; keep command paths conservative.
function quoteCommand(value: string): string {
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : shellQuote(value);
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=,.-]+$/.test(value) ? value : shellQuote(value);
}
