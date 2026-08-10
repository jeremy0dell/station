import type { CliSetupHarnessId } from "@station/contracts";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import type { CliEnv } from "../../../env.js";
import type { SetupHarnessFact } from "../adapters/inspectionTypes.js";
import { SETUP_HARNESS_DEFINITIONS, type SetupHarnessDefinition } from "../harnessDefinitions.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { commandEnv, setupEnv } from "./env.js";

export type CheckHarnessesOptions = {
  runner?: ExternalCommandRunner;
  env?: CliEnv;
  cwd?: string;
  homeDir?: string;
  configuredHarnesses?: readonly string[];
  configuredCommands?: Readonly<Partial<Record<CliSetupHarnessId, string>>>;
};

export async function checkSetupHarnesses(
  options: CheckHarnessesOptions = {},
): Promise<SetupHarnessFact[]> {
  const env = setupEnv(options.env);
  const facts: SetupHarnessFact[] = [];
  for (const definition of Object.values(SETUP_HARNESS_DEFINITIONS)) {
    facts.push(await checkHarness(definition, env, options));
  }
  return facts;
}

async function checkHarness(
  definition: SetupHarnessDefinition,
  env: CliEnv,
  options: CheckHarnessesOptions,
): Promise<SetupHarnessFact> {
  const configuredCommand = options.configuredCommands?.[definition.id];
  const environmentCommand = env[definition.commandEnvVar];
  const command = configuredCommand ?? environmentCommand ?? definition.commandFallback;
  const defaultCommandHomeDir =
    options.configuredHarnesses?.includes(definition.id) !== true &&
    configuredCommand === undefined &&
    environmentCommand === undefined
      ? options.homeDir
      : undefined;
  for (const candidate of harnessCommandCandidates(
    command,
    defaultCommandHomeDir,
    definition.additionalUserCommandDirectories,
  )) {
    try {
      const input: ExternalCommandInput = {
        command: candidate,
        args: ["--version"],
        timeoutMs: setupProbeTimeoutMs,
        maxOutputChars: 4096,
      };
      if (options.cwd !== undefined) input.cwd = options.cwd;
      const externalEnv = commandEnv(options.env);
      if (externalEnv !== undefined) input.env = externalEnv;
      const output = await runExternalCommand(input, options.runner);
      const rawVersion = `${output.stdout}${output.stderr}`.trim();
      const fact: SetupHarnessFact = {
        id: definition.id,
        label: definition.label,
        status: "ok",
        command: candidate,
      };
      if (rawVersion.length > 0) fact.rawVersion = rawVersion;
      const version = parseHarnessVersion(rawVersion);
      if (version !== undefined) fact.version = version;
      return fact;
    } catch (error) {
      // A failed candidate is expected while checking provider-specific fallback locations.
      void error;
    }
  }
  return {
    id: definition.id,
    label: definition.label,
    status: "missing",
    command,
    message: `${definition.label} CLI is not available.`,
  };
}

function parseHarnessVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

function harnessCommandCandidates(
  command: string,
  homeDir: string | undefined,
  additionalUserCommandDirectories: readonly string[] | undefined,
): string[] {
  if (command.includes("/") || homeDir === undefined) {
    return [command];
  }
  const candidates = [command, `${homeDir}/.local/bin/${command}`];
  for (const directory of additionalUserCommandDirectories ?? []) {
    candidates.push(`${homeDir}/${directory}/${command}`);
  }
  return candidates;
}
