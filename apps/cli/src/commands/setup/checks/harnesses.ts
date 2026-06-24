import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import type { CliEnv } from "../../../env.js";
import type { SetupHarnessFact, SupportedHarnessId } from "../model.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { commandEnv, setupEnv } from "./env.js";

export type HarnessDefinition = {
  id: SupportedHarnessId;
  label: string;
  envKey: string;
  defaultCommand: string;
};

export const harnessDefinitions: readonly HarnessDefinition[] = [
  { id: "codex", label: "Codex", envKey: "STATION_CODEX_BIN", defaultCommand: "codex" },
  {
    id: "cursor",
    label: "Cursor Agent",
    envKey: "STATION_CURSOR_AGENT_BIN",
    defaultCommand: "agent",
  },
  { id: "opencode", label: "OpenCode", envKey: "STATION_OPENCODE_BIN", defaultCommand: "opencode" },
  { id: "crush", label: "Crush", envKey: "STATION_CRUSH_BIN", defaultCommand: "crush" },
  { id: "pi", label: "Pi", envKey: "STATION_PI_BIN", defaultCommand: "pi" },
  { id: "claude", label: "Claude Code", envKey: "STATION_CLAUDE_BIN", defaultCommand: "claude" },
] as const;

export type CheckHarnessesOptions = {
  runner?: ExternalCommandRunner;
  env?: CliEnv;
  cwd?: string;
  homeDir?: string;
};

export async function checkSetupHarnesses(
  options: CheckHarnessesOptions = {},
): Promise<SetupHarnessFact[]> {
  const env = setupEnv(options.env);
  const facts: SetupHarnessFact[] = [];
  for (const definition of harnessDefinitions) {
    facts.push(await checkHarness(definition, env, options));
  }
  return facts;
}

function harnessCommand(definition: HarnessDefinition, env: CliEnv): string {
  return env[definition.envKey] ?? definition.defaultCommand;
}

async function checkHarness(
  definition: HarnessDefinition,
  env: CliEnv,
  options: CheckHarnessesOptions,
): Promise<SetupHarnessFact> {
  const command = harnessCommand(definition, env);
  for (const candidate of harnessCommandCandidates(command, options.homeDir)) {
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
    } catch {}
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

function harnessCommandCandidates(command: string, homeDir: string | undefined): string[] {
  if (command.includes("/") || homeDir === undefined) {
    return [command];
  }
  return [command, `${homeDir}/.local/bin/${command}`];
}
