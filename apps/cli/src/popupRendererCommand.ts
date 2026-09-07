import type { ExecutableArgv } from "./selfExec.js";

/** Builds the exact dashboard command shared by ordinary launch and warm reuse checks. */
export function buildPopupRendererCommand(
  executable: ExecutableArgv,
  configPath: string | undefined,
  commandOverride?: string,
): string {
  const parts = commandOverride === undefined ? executable.map(shellQuote) : [commandOverride];
  if (configPath !== undefined) parts.push("--config", shellQuote(configPath));
  parts.push("tui", "--popup", "--persistent");
  return parts.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
