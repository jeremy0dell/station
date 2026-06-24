import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import type { CliEnv } from "../../../env.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { commandEnv } from "./env.js";

export type ToolchainStatus = "ok" | "missing" | "incompatible";

export type ToolchainFact = {
  status: ToolchainStatus;
  label: string;
  actual?: string;
  expected: string;
  message: string;
};

export type CheckToolchainOptions = {
  runner?: ExternalCommandRunner;
  env?: CliEnv;
  cwd?: string;
  nodeVersion?: string;
};

export async function checkSetupToolchain(
  options: CheckToolchainOptions = {},
): Promise<{ node: ToolchainFact; pnpm: ToolchainFact }> {
  const [node, pnpm] = await Promise.all([checkNodeVersion(options), checkPnpmVersion(options)]);
  return { node, pnpm };
}

function checkNodeVersion(options: CheckToolchainOptions): ToolchainFact {
  const actual = normalizeVersion(options.nodeVersion ?? process.version);
  if (actual.startsWith("24.")) {
    return {
      status: "ok",
      label: "Node.js",
      actual,
      expected: "24.x",
      message: `Node.js ${actual} is compatible.`,
    };
  }
  return {
    status: "incompatible",
    label: "Node.js",
    actual,
    expected: "24.x",
    message: `Node.js ${actual} is incompatible; STATION development expects Node.js 24.x.`,
  };
}

async function checkPnpmVersion(options: CheckToolchainOptions): Promise<ToolchainFact> {
  try {
    const input: ExternalCommandInput = {
      command: "pnpm",
      args: ["--version"],
      timeoutMs: setupProbeTimeoutMs,
      maxOutputChars: 4096,
    };
    if (options.cwd !== undefined) input.cwd = options.cwd;
    const env = commandEnv(options.env);
    if (env !== undefined) input.env = env;
    const output = await runExternalCommand(input, options.runner);
    const actual = normalizeVersion(`${output.stdout}${output.stderr}`.trim());
    if (actual.startsWith("11.")) {
      return {
        status: "ok",
        label: "pnpm",
        actual,
        expected: "11.x",
        message: `pnpm ${actual} is compatible.`,
      };
    }
    return {
      status: "incompatible",
      label: "pnpm",
      actual,
      expected: "11.x",
      message: `pnpm ${actual} is incompatible; STATION development expects pnpm 11.x.`,
    };
  } catch {
    return {
      status: "missing",
      label: "pnpm",
      expected: "11.x",
      message: "pnpm is not available; STATION development expects pnpm 11.x.",
    };
  }
}

function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}
