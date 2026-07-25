import type {
  HarnessHooksStatus,
  HarnessProvider,
  SafeError,
  TerminalProvider,
} from "@station/contracts";
import { commandLine } from "@station/runtime";
import type { ProviderRegistry } from "../providers/registry.js";

export function resolveTerminalProviderOrThrow(
  providers: ProviderRegistry,
  providerId: string,
): TerminalProvider {
  const provider = providers.terminals.get(providerId);
  if (provider !== undefined) {
    return provider;
  }
  const error: SafeError = {
    tag: "TerminalProviderError",
    code: "TERMINAL_PROVIDER_UNAVAILABLE",
    message: "The requested terminal provider is not registered.",
    provider: providerId,
  };
  throw error;
}

export function resolveHarnessProviderOrThrow(
  providers: ProviderRegistry,
  providerId: string,
): HarnessProvider {
  const provider = providers.harnesses.get(providerId);
  if (provider !== undefined) {
    return provider;
  }
  const error: SafeError = {
    tag: "HarnessProviderError",
    code: "HARNESS_PROVIDER_UNAVAILABLE",
    message: "The requested harness provider is not registered.",
    provider: providerId,
  };
  throw error;
}

/**
 * Reject if the harness's status hooks are not installed. A launched agent with
 * no hooks never reports status, so the observer would never converge its row to
 * `working` — better to fail fast with install guidance than spawn a half-wired
 * agent. Fails open for harnesses that cannot report hook status.
 */
export async function assertHooksInstalledOrThrow(
  provider: HarnessProvider,
  options: { stationConfigPath?: string } = {},
): Promise<void> {
  if (provider.hooksStatus === undefined) {
    return;
  }
  let status: HarnessHooksStatus;
  try {
    status = await provider.hooksStatus(
      options.stationConfigPath === undefined
        ? undefined
        : { stationConfigPath: options.stationConfigPath },
    );
  } catch {
    const doctorCommand = providerHookCommand(provider.id, "doctor", options.stationConfigPath);
    const error: SafeError = {
      tag: "HarnessProviderError",
      code: "HARNESS_HOOKS_STATUS_FAILED",
      message: `STATION could not verify whether ${provider.id} status hooks are installed.`,
      hint: `Run \`${doctorCommand}\` to diagnose, then retry.`,
      provider: provider.id,
    };
    throw error;
  }
  const installCommand = providerHookCommand(provider.id, "install", options.stationConfigPath);
  const doctorCommand = providerHookCommand(provider.id, "doctor", options.stationConfigPath);
  if (status.installed) {
    return;
  }
  // When hooks are not *requested* in config, installing the artifacts alone does
  // not satisfy the gate (the provider reports `installed:false` while disabled),
  // so the install-only hint would loop. Point the user at the config flag.
  const error: SafeError = status.requested
    ? {
        tag: "CommandValidationError",
        code: "HARNESS_HOOKS_NOT_INSTALLED",
        message: `${provider.id} status hooks are not installed, so the observer cannot track this agent.`,
        hint: `Run \`${installCommand}\`, then \`${doctorCommand}\` to confirm, and retry.`,
        provider: provider.id,
      }
    : {
        tag: "CommandValidationError",
        code: "HARNESS_HOOKS_NOT_INSTALLED",
        message: `${provider.id} status hooks are not enabled, so the observer cannot track this agent.`,
        hint: `Enable hooks for this harness — set 'install_hooks = true' under [harness.${provider.id}] in your station config (or run \`stn setup\`), then run \`${installCommand}\` and retry.`,
        provider: provider.id,
      };
  throw error;
}

function providerHookCommand(
  providerId: string,
  action: "doctor" | "install",
  configPath: string | undefined,
): string {
  const args = ["stn"];
  if (configPath !== undefined) {
    args.push("--config", configPath);
  }
  args.push("hooks", action, providerId);
  if (action === "install") {
    args.push("--yes");
  }
  return commandLine(args);
}
