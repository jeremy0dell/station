import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RealE2eEnvironment } from "./env";
import { requireToolPath } from "./env";

export type PiLaunchWrapper = {
  wrapperPath: string;
  launchLogPath: string;
};

export async function createPiLaunchLoggingWrapper(input: {
  env: RealE2eEnvironment;
  root: string;
  execRealPi?: boolean;
}): Promise<PiLaunchWrapper> {
  const wrapperPath = join(input.root, "pi-with-station-log.sh");
  const launchLogPath = join(input.root, "pi-launch.log");
  const piBin = requireToolPath(input.env, "pi");
  await writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "{",
      `  printf 'cwd=%s\\n' "$PWD"`,
      `  for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done`,
      `  printf 'env.STATION_CONFIG_PATH=%s\\n' "\${STATION_CONFIG_PATH-}"`,
      `  printf 'env.STATION_HARNESS_PROVIDER=%s\\n' "\${STATION_HARNESS_PROVIDER-}"`,
      `  printf 'env.STATION_SESSION_ID=%s\\n' "\${STATION_SESSION_ID-}"`,
      `} >> ${shellSingleQuote(launchLogPath)}`,
      ...wrapperTailLines(piBin, input.execRealPi === true),
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o700);
  return { wrapperPath, launchLogPath };
}

function wrapperTailLines(piBin: string, execRealPi: boolean): string[] {
  if (execRealPi) {
    return [`exec ${shellSingleQuote(piBin)} "$@"`];
  }
  return [
    `if [ "\${1-}" = "--version" ]; then`,
    `  exec ${shellSingleQuote(piBin)} "$@"`,
    "fi",
    "exec sleep 300",
  ];
}

export async function waitForPiLaunchLog(
  wrapper: PiLaunchWrapper,
  text: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const content = await readFile(wrapper.launchLogPath, "utf8").catch(() => "");
    if (content.includes(text)) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${wrapper.launchLogPath} did not contain ${text}.`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
