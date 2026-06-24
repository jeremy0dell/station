import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import type { CliEnv } from "../../../env.js";
import type { SetupBrewFact } from "../model.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { commandEnv } from "./env.js";

export type CheckBrewOptions = {
  runner?: ExternalCommandRunner;
  env?: CliEnv;
  cwd?: string;
  noBrew?: boolean;
};

export async function checkBrewDependency(options: CheckBrewOptions = {}): Promise<SetupBrewFact> {
  if (options.noBrew === true) {
    return {
      status: "skipped",
      command: "brew",
      message: "Homebrew actions were skipped by --no-brew.",
    };
  }
  try {
    const input: ExternalCommandInput = {
      command: "brew",
      args: ["--version"],
      timeoutMs: setupProbeTimeoutMs,
      maxOutputChars: 4096,
    };
    if (options.cwd !== undefined) input.cwd = options.cwd;
    const env = commandEnv(options.env);
    if (env !== undefined) input.env = env;
    const output = await runExternalCommand(input, options.runner);
    const rawVersion = `${output.stdout}${output.stderr}`.trim();
    const fact: SetupBrewFact = {
      status: "ok",
      command: "brew",
    };
    const firstLine = rawVersion.split("\n")[0];
    if (rawVersion.length > 0 && firstLine !== undefined) fact.version = firstLine;
    return fact;
  } catch {
    return {
      status: "missing",
      command: "brew",
      message: "Homebrew is unavailable; setup will print manual install commands.",
    };
  }
}
