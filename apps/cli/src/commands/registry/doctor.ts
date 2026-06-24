import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type {
  CliCommandConfigErrorContext,
  CliCommandNode,
  CliCommandRunContext,
} from "../cliCommand/types.js";
import { isConfigError, runInvalidConfigDoctor } from "../configDiagnostics.js";
import { runDoctorCommand } from "../doctor.js";

export const doctorCliCommand: CliCommandNode = {
  name: "doctor",
  description: "Diagnose STATION config, observer health, providers, and hooks.",
  requiresConfig: true,
  run: runDoctorCliCommand,
  handleConfigError: handleDoctorConfigError,
  usage: ["stn doctor [--project <id>]"],
  options: [
    {
      name: "--project <id>",
      description: "Limit project-specific diagnostics to one project.",
    },
  ],
  examples: ["pnpm stn doctor", "pnpm stn --config ./station.toml doctor --help"],
  notes: [
    "Normal doctor output may read config and inspect the local observer.",
    "Doctor help and manual output does not require a valid config file.",
  ],
};

async function runDoctorCliCommand(context: CliCommandRunContext) {
  const result = await runDoctorCommand(
    context.args,
    loadedCommandOptions(context),
    context.options.observerDeps,
  );
  return { code: result.status === "unavailable" ? 1 : 0, output: result };
}

async function handleDoctorConfigError(error: unknown, _context: CliCommandConfigErrorContext) {
  if (!isConfigError(error)) {
    return undefined;
  }
  const result = await runInvalidConfigDoctor({
    error,
    configPath: error.configPath,
  });
  return { code: 1, output: result };
}
