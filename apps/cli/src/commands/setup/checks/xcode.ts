import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import type { CliEnv } from "../../../env.js";
import type { SetupXcodeFact } from "../model.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { commandEnv } from "./env.js";

export type CheckXcodeOptions = {
  runner?: ExternalCommandRunner;
  env?: CliEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
};

const commandLineToolsInstallHint =
  "Command Line Tools are not installed. Run xcode-select --install, then run stn setup.";

/**
 * Source-checkout macOS Command Line Tools probe for Homebrew and native builds.
 * Compiled setup skips this check and accepts any Git implementation that passes
 * its own probe; non-darwin hosts report a not-applicable ok without plan noise.
 */
export async function checkSetupXcode(options: CheckXcodeOptions = {}): Promise<SetupXcodeFact> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "ok", applicable: false };
  }
  try {
    const result = await xcodeSelectPath(options);
    const path = result.stdout.trim();
    if (path.length === 0) {
      return { status: "missing", applicable: true, message: commandLineToolsInstallHint };
    }
    return { status: "ok", applicable: true, path };
  } catch {
    return { status: "missing", applicable: true, message: commandLineToolsInstallHint };
  }
}

function xcodeSelectPath(options: CheckXcodeOptions) {
  const input: ExternalCommandInput = {
    command: "xcode-select",
    args: ["-p"],
    timeoutMs: setupProbeTimeoutMs,
    maxOutputChars: 4096,
  };
  if (options.cwd !== undefined) input.cwd = options.cwd;
  const env = commandEnv(options.env);
  if (env !== undefined) input.env = env;
  return runExternalCommand(input, options.runner);
}
