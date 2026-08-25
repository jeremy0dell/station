import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import { z } from "zod";
import type { CliEnv } from "../../../env.js";
import { resolveStationWorkspaceDir } from "../../../stationWorkspace.js";
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
  expectedBunVersion?: string;
};

const execFileAsync = promisify(execFile);
const BunVersionSchema = z.string().regex(/^[^\s]+$/u);

export async function checkSetupToolchain(
  options: CheckToolchainOptions = {},
): Promise<{ node: ToolchainFact; bun: ToolchainFact }> {
  const expectedBunVersion = options.expectedBunVersion ?? (await sourceBunVersionPolicy());
  const [node, bun] = await Promise.all([
    checkNodeVersion(options),
    checkBunVersion(options, expectedBunVersion),
  ]);
  return { node, bun };
}

function checkNodeVersion(options: CheckToolchainOptions): ToolchainFact {
  const actual = normalizeVersion(options.nodeVersion ?? process.version);
  if (isSupportedNodeVersion(actual)) {
    return {
      status: "ok",
      label: "Node.js",
      actual,
      expected: ">=24.2 <25",
      message: `Node.js ${actual} is compatible.`,
    };
  }
  return {
    status: "incompatible",
    label: "Node.js",
    actual,
    expected: ">=24.2 <25",
    message: `Node.js ${actual} is incompatible; STATION development expects Node.js 24.2+ and below 25.`,
  };
}

function isSupportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 24 && (minor > 2 || (minor === 2 && patch >= 0));
}

async function checkBunVersion(
  options: CheckToolchainOptions,
  expected: string,
): Promise<ToolchainFact> {
  try {
    const input: ExternalCommandInput = {
      command: "bun",
      args: ["--version"],
      timeoutMs: setupProbeTimeoutMs,
      maxOutputChars: 4096,
    };
    if (options.cwd !== undefined) input.cwd = options.cwd;
    const env = commandEnv(options.env);
    if (env !== undefined) input.env = env;
    const output = await runExternalCommand(input, options.runner);
    const actual = normalizeVersion(`${output.stdout}${output.stderr}`.trim());
    if (actual === expected) {
      return {
        status: "ok",
        label: "Bun",
        actual,
        expected,
        message: `Bun ${actual} matches the repository policy.`,
      };
    }
    return {
      status: "incompatible",
      label: "Bun",
      actual,
      expected,
      message: `Bun ${actual} is incompatible; Station development expects Bun ${expected}.`,
    };
  } catch {
    return {
      status: "missing",
      label: "Bun",
      expected,
      message: `Bun is not available; Station development expects Bun ${expected}.`,
    };
  }
}

async function sourceBunVersionPolicy(): Promise<string> {
  const policyScript = join(dirname(resolveStationWorkspaceDir()), "scripts", "bun-version.mjs");
  const { stdout } = await execFileAsync(process.execPath, [policyScript, "--print"], {
    encoding: "utf8",
    maxBuffer: 4096,
  });
  return BunVersionSchema.parse(stdout.trim());
}

function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}
