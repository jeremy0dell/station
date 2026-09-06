import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderHookArtifactOwner, ProviderHookArtifactOwnership } from "@station/contracts";
import { isHookOwnershipConflict, sameOwnerOwnership } from "@station/harness-shared";
import {
  assertProviderHookArtifactOwnership,
  classifyProviderHookArtifactOwnership,
  createHookSetupFileOps,
  providerHookOwnerMarker,
} from "@station/runtime";
import { openCodeForwardedEventTypes } from "./ingressRules.js";
import { renderStationOpenCodePlugin } from "./pluginScript.js";

export const OPENCODE_STATION_PLUGIN_NAME = "station-agent-state.js";
export const OPENCODE_STATION_PLUGIN_MARKER = "station-opencode-observer-plugin:v1";

export type OpenCodePluginPlanOptions = {
  opencodeConfigDir?: string;
  pluginPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
};

export type OpenCodePluginPlan = {
  provider: "opencode";
  configDir: string;
  pluginPath: string;
  changed: boolean;
  installed: boolean;
  before: string;
  after: string;
  ownership?: ProviderHookArtifactOwnership;
};

export type OpenCodePluginInstallResult = OpenCodePluginPlan & {
  installed: boolean;
  backupPath?: string;
  removed?: boolean;
};

export type OpenCodePluginDoctorResult = {
  provider: "opencode";
  configDir: string;
  pluginPath: string;
  status: "ok" | "warn";
  installed: boolean;
  changed: boolean;
  message: string;
  ownership?: ProviderHookArtifactOwnership;
};

const fileOps = createHookSetupFileOps(({ operation, path, cause }) => {
  return new Error(`OpenCode plugin setup ${operation} failed for ${path}.`, { cause });
});

export async function planOpenCodePlugin(
  options: OpenCodePluginPlanOptions = {},
): Promise<OpenCodePluginPlan> {
  const configDir = resolveOpenCodeConfigDir(options);
  const pluginPath = resolveOpenCodePluginPath(options);
  const before = await fileOps.readOptionalFile(pluginPath);
  const after = expectedOpenCodePluginScript(options);
  const changed = before !== after;
  const ownership = openCodePluginOwnership(before, options);
  const result: OpenCodePluginPlan = {
    provider: "opencode",
    configDir,
    pluginPath,
    changed,
    installed: before.includes(OPENCODE_STATION_PLUGIN_MARKER),
    before,
    after,
  };
  if (ownership !== undefined) result.ownership = ownership;
  return result;
}

export async function installOpenCodePlugin(
  options: OpenCodePluginPlanOptions = {},
): Promise<OpenCodePluginInstallResult> {
  const plan = await planOpenCodePlugin(options);
  const current = await fileOps.readOptionalFile(plan.pluginPath);
  assertOpenCodePluginOwnership("install", plan.pluginPath, current, options);
  let backupPath: string | undefined;
  if (plan.changed) {
    backupPath = await fileOps.backupIfPresent(plan.pluginPath);
    await fileOps.writeHookConfig(plan.pluginPath, plan.after);
  }
  const result: OpenCodePluginInstallResult = {
    ...plan,
    installed: true,
  };
  if (options.artifactOwner !== undefined) {
    result.ownership = sameOwnerOwnership(options.artifactOwner);
  }
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
  }
  return result;
}

export async function uninstallOpenCodePlugin(
  options: OpenCodePluginPlanOptions = {},
): Promise<OpenCodePluginInstallResult> {
  const plan = await planOpenCodePlugin(options);
  const current = await fileOps.readOptionalFile(plan.pluginPath);
  assertOpenCodePluginOwnership("uninstall", plan.pluginPath, current, options);
  let removed = false;
  if (plan.before.includes(OPENCODE_STATION_PLUGIN_MARKER)) {
    removed = await fileOps.removeHookFileIfPresent(plan.pluginPath);
  }
  return {
    ...plan,
    changed: removed,
    installed: false,
    removed,
  };
}

export async function doctorOpenCodePlugin(
  options: OpenCodePluginPlanOptions & { enabled?: boolean } = {},
): Promise<OpenCodePluginDoctorResult> {
  const plan = await planOpenCodePlugin(options);
  const installed = plan.before.includes(OPENCODE_STATION_PLUGIN_MARKER);
  const ownershipConflict = isHookOwnershipConflict(plan.ownership);
  if (!installed && options.enabled === true) {
    return {
      provider: "opencode",
      configDir: plan.configDir,
      pluginPath: plan.pluginPath,
      status: "warn",
      installed: ownershipConflict ? false : installed,
      changed: true,
      message: "OpenCode event plugin is not installed.",
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }
  if (installed && (plan.changed || ownershipConflict)) {
    return {
      provider: "opencode",
      configDir: plan.configDir,
      pluginPath: plan.pluginPath,
      status: "warn",
      installed: ownershipConflict ? false : installed,
      changed: true,
      message: ownershipConflict
        ? "OpenCode event plugin ownership conflicts with this Station runtime; run `stn hooks install opencode --yes --takeover` only to transfer it."
        : "OpenCode event plugin is installed but differs from the expected STATION plugin.",
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }
  return {
    provider: "opencode",
    configDir: plan.configDir,
    pluginPath: plan.pluginPath,
    status: "ok",
    installed,
    changed: false,
    message: installed
      ? "OpenCode event plugin is installed."
      : "OpenCode event plugin is not requested.",
    ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
  };
}

export function resolveOpenCodeConfigDir(options: OpenCodePluginPlanOptions = {}): string {
  if (options.opencodeConfigDir !== undefined) {
    return options.opencodeConfigDir;
  }
  const env = options.env ?? process.env;
  if (env.OPENCODE_CONFIG_DIR !== undefined && env.OPENCODE_CONFIG_DIR.length > 0) {
    return env.OPENCODE_CONFIG_DIR;
  }
  return join(options.homeDir ?? homedir(), ".config", "opencode");
}

export function resolveOpenCodePluginPath(options: OpenCodePluginPlanOptions = {}): string {
  return (
    options.pluginPath ??
    join(resolveOpenCodeConfigDir(options), "plugins", OPENCODE_STATION_PLUGIN_NAME)
  );
}

/**
 * ADAPTER
 *
 * Generates the OpenCode boundary that compacts events and delegates delivery to CLI ingress.
 */
export function expectedOpenCodePluginScript(options: OpenCodePluginPlanOptions = {}): string {
  const ownerMarker =
    options.artifactOwner === undefined
      ? []
      : [`// ${providerHookOwnerMarker(options.artifactOwner)}`];
  const header = [
    `// ${OPENCODE_STATION_PLUGIN_MARKER}`,
    ...ownerMarker,
    "// Generated by STATION. Do not edit by hand.",
  ].join("\n");
  return `${header}
${renderStationOpenCodePlugin({
  observerSocketPath: options.observerSocketPath ?? "",
  stateDir: options.stateDir ?? "",
  hookSpoolDir: options.hookSpoolDir ?? "",
  forwardedEventTypes: openCodeForwardedEventTypes,
})}`;
}

function openCodePluginOwnership(
  contents: string,
  options: OpenCodePluginPlanOptions,
): ProviderHookArtifactOwnership | undefined {
  if (options.artifactOwner === undefined) return undefined;
  return classifyProviderHookArtifactOwnership({
    contents,
    requested: options.artifactOwner,
  });
}

function assertOpenCodePluginOwnership(
  action: "install" | "uninstall",
  pluginPath: string,
  contents: string,
  options: OpenCodePluginPlanOptions,
): void {
  assertProviderHookArtifactOwnership({
    provider: "opencode",
    action,
    artifactPath: pluginPath,
    contents,
    ...(options.artifactOwner === undefined ? {} : { requested: options.artifactOwner }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
  });
}
