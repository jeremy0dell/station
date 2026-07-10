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

function compiledRunners(): SelfExecRunners {
  return {
    cli: async (argv) => (await import("@station/cli/main")).runCliMain(argv),
    observer: async (argv) => {
      const { runCliObserverMain } = await import("@station/cli/observer-main");
      process.exitCode = await runCliObserverMain(argv, {
        preparePiExtension: prepareCompiledPiExtension,
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
      (await import("@station/cli/main")).runCliMain(popupArgv(argv)),
  };
}

/**
 * COMPOSITION ROOT
 *
 * Binds compiled raw arguments to lazy process entries and packaged runtime assets.
 */
export async function runStationBinaryMain(): Promise<void> {
  await dispatchSelfExec(
    {
      // Bun preserves the invoked symlink in argv0 while process.argv[0] names the executable.
      argv0: process.argv0,
      argv: process.argv.slice(2),
    },
    compiledRunners(),
  );
}

if (import.meta.main) {
  await runStationBinaryMain();
}
