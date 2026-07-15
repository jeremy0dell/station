import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  HarnessReadinessFacts,
  HarnessReadinessProbeContext,
  HarnessReadinessProvider,
  HarnessReadinessTechnicalDetail,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  type HarnessCliProbeOptions,
  harnessCommand,
  harnessReadinessFacts,
  mergeReadinessTechnicalDetails,
  probeHarnessCli,
  withIsolatedReadinessEnvironment,
} from "@station/harness-shared";
import { resolvePiExtensionPath } from "./launch.js";

export type PiHarnessReadinessProviderOptions = CommonHarnessProviderOptions & {
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
};

type ExtensionProbe = {
  trackingSetup: HarnessReadinessFacts["trackingSetup"];
  technicalDetails: HarnessReadinessTechnicalDetail[];
};

/**
 * ADAPTER
 *
 * Translates Pi CLI and bundled-extension integrity evidence into
 * provider-neutral readiness facts without changing Pi or Station state.
 */
export function createPiHarnessReadinessProvider(
  options: PiHarnessReadinessProviderOptions = {},
): HarnessReadinessProvider {
  return {
    id: "pi",
    probe: (context) => probePiReadiness(options, context),
  };
}

async function probePiReadiness(
  options: PiHarnessReadinessProviderOptions,
  context: HarnessReadinessProbeContext = {},
): Promise<HarnessReadinessFacts> {
  const [cli, extension] = await Promise.all([
    withIsolatedReadinessEnvironment(
      {
        providerHomeEnv: "PI_CODING_AGENT_DIR",
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      ({ cwd, env, providerHomeDir }) => {
        env.PI_CODING_AGENT_SESSION_DIR = join(providerHomeDir, "sessions");
        env.PI_OFFLINE = "1";
        env.PI_SKIP_VERSION_CHECK = "1";
        env.PI_TELEMETRY = "0";
        return probeHarnessCli(cliProbeOptions(options, env, cwd), context);
      },
    ),
    probeExtension(resolvePiExtensionPath(options)),
  ]);
  return harnessReadinessFacts({
    cli: cli.cli,
    authentication: "not_applicable",
    launchability:
      cli.cli === "available" ? "ready" : cli.cli === "missing" ? "blocked" : "unknown",
    trackingSetup: extension.trackingSetup,
    technicalDetails: mergeReadinessTechnicalDetails(
      cli.technicalDetails,
      extension.technicalDetails,
    ),
    ...(cli.installedVersion === undefined ? {} : { installedVersion: cli.installedVersion }),
  });
}

async function probeExtension(path: string): Promise<ExtensionProbe> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
      return invalidExtension();
    }
    await access(path, fsConstants.R_OK);
    const contents = await readFile(path);
    if (contents.byteLength === 0 || !matchesContentAddress(path, contents)) {
      return invalidExtension();
    }
    return { trackingSetup: "prepared", technicalDetails: [] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        trackingSetup: "repair_needed",
        technicalDetails: [
          {
            code: "HARNESS_PI_EXTENSION_MISSING",
            message: "Station's Pi extension is missing; reinstall Station.",
          },
        ],
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return invalidExtension();
    }
    return {
      trackingSetup: "unknown",
      technicalDetails: [
        {
          code: code ?? "HARNESS_PI_EXTENSION_CHECK_FAILED",
          message: "Station's Pi extension could not be inspected.",
        },
      ],
    };
  }
}

function matchesContentAddress(path: string, contents: Uint8Array): boolean {
  const match = basename(dirname(path)).match(/-([a-f0-9]{64})$/i);
  if (match === null) {
    return true;
  }
  return createHash("sha256").update(contents).digest("hex") === match[1]?.toLowerCase();
}

function invalidExtension(): ExtensionProbe {
  return {
    trackingSetup: "repair_needed",
    technicalDetails: [
      {
        code: "HARNESS_PI_EXTENSION_INVALID",
        message: "Station's Pi extension is invalid; reinstall Station.",
      },
    ],
  };
}

function cliProbeOptions(
  options: PiHarnessReadinessProviderOptions,
  env: Record<string, string>,
  cwd: string,
): HarnessCliProbeOptions {
  const probeOptions: HarnessCliProbeOptions = {
    command: harnessCommand(options, "STATION_PI_BIN", "pi"),
    cwd,
    env,
  };
  if (options.runner !== undefined) {
    probeOptions.runner = options.runner;
  }
  if (options.timeoutMs !== undefined) {
    probeOptions.timeoutMs = options.timeoutMs;
  }
  return probeOptions;
}
