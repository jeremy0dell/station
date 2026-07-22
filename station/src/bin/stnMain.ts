import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { dispatchSelfExec, type SelfExecRunners } from "@station/cli/self-exec";
import cttyHelperAsset from "../../dist/ctty-helper" with { type: "file" };
import piExtensionAsset from "../../dist/piExtension.mjs" with { type: "file" };
import {
  preparePackagedPiExtension,
  preparePackagedPtyRuntime,
} from "./packagedAssets.js";

const prepareCompiledPtyRuntime = (stateDir: string) =>
  preparePackagedPtyRuntime(stateDir, cttyHelperAsset);

const prepareCompiledPiExtension = (stateDir: string) =>
  preparePackagedPiExtension(stateDir, piExtensionAsset);

function popupArgv(argv: readonly string[]): readonly string[] {
  return argv[0] === "popup" ? argv : ["popup", ...argv];
}

function compiledRunners(installedRoot: string): SelfExecRunners {
  const providerHookIngressLauncher = join(installedRoot, "stn-ingress");
  const cliOptions = {
    providerHookIngressLauncher,
    popupDeps: {
      checkoutRoot: installedRoot,
      preferRegisteredDevPopup: false,
    },
    setupDeps: {
      tmuxPopupOwnerRoot: installedRoot,
    },
  };
  return {
    cli: async (argv) => (await import("@station/cli/main")).runCliMain(argv, cliOptions),
    observer: async (argv) => {
      const { runCliObserverMain } = await import("@station/cli/observer-main");
      process.exitCode = await runCliObserverMain(argv, {
        preparePiExtension: prepareCompiledPiExtension,
        providerHookIngressLauncher,
      });
    },
    ingress: async (argv) => (await import("@station/cli/ingress-main")).runCliIngressMain(argv),
    tui: async () =>
      (await import("../main.js")).runStationMain({
        preparePtyRuntime: prepareCompiledPtyRuntime,
      }),
    dashboard: async () => (await import("../dashboardRenderer/main.js")).runDashboardMain(),
    stationHost: async (argv) =>
      (await import("../host/hostMain.js")).runStationHostMain(argv, {
        preparePtyRuntime: prepareCompiledPtyRuntime,
      }),
    tmuxPopup: async (argv) =>
      (await import("@station/cli/main")).runCliMain(popupArgv(argv), cliOptions),
  };
}

/**
 * COMPOSITION ROOT
 *
 * Binds compiled raw arguments to lazy process entries, packaged runtime assets,
 * installed launcher identity, popup ownership, and setup wiring.
 */
export async function runStationBinaryMain(): Promise<void> {
  const installedRoot = dirname(realpathSync(process.execPath));
  await dispatchSelfExec(
    {
      // Bun preserves the invoked symlink in argv0 while process.argv[0] names the executable.
      argv0: process.argv0,
      argv: process.argv.slice(2),
    },
    compiledRunners(installedRoot),
  );
}

if (import.meta.main) {
  await runStationBinaryMain();
}
