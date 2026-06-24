import type { CliEnv } from "../../../env.js";

export function setupEnv(input: CliEnv | undefined): CliEnv {
  return input ?? process.env;
}

export function commandEnv(input: CliEnv | undefined): Record<string, string> | undefined {
  if (input === undefined) {
    return undefined;
  }
  const entries = Object.entries(input).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return Object.fromEntries(entries);
}
