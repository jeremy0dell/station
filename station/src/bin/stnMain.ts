import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { dispatchSelfExec, type SelfExecRunners } from "@station/cli/self-exec";
import cttyHelperAsset from "../../dist/ctty-helper" with { type: "file" };
import piExtensionAsset from "../../dist/piExtension.mjs" with { type: "file" };
const prepareCompiledPtyRuntime = async (stateDir: string) =>
  (await import("./packagedAssets.js")).preparePackagedPtyRuntime(stateDir, cttyHelperAsset);

const prepareCompiledPiExtension = async (stateDir: string) =>
  (await import("./packagedAssets.js")).preparePackagedPiExtension(stateDir, piExtensionAsset);

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
      const { runCliObserverMain, runCliObserverProcess } = await import(
        "@station/cli/observer-main"
      );
      process.exitCode = await runCliObserverProcess((startupReadinessSink) =>
        runCliObserverMain(argv, {
          preparePiExtension: prepareCompiledPiExtension,
          providerHookIngressLauncher,
          startupReadinessSink,
        }),
      );
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
      (await import("@station/cli/tmux-popup-main")).runTmuxPopupMain(
        argv,
        installedRoot,
        async (popupArgv) => (await import("@station/cli/main")).runCliMain(popupArgv, cliOptions),
      ),
  };
}

/**
 * COMPOSITION ROOT
 *
 * Binds compiled raw arguments to lazy process entries, packaged runtime assets,
 * installed launcher identity, the shared Observer process failure boundary,
 * current-build popup reuse, popup ownership, and setup wiring.
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
