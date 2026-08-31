import { startProcessSampler } from "./processSampler.mjs";

type ProfileTarget = "observer" | "tui" | "dashboard" | "host";

/** Runs one source/HMR Station entrypoint with the same opt-in sampler as diagnostic binaries. */
async function main(): Promise<void> {
  const target = parseTarget(process.env.STATION_PROFILE_TARGET);
  const sampler =
    process.env.STATION_MEMORY_SAMPLE_PATH === undefined
      ? undefined
      : await startProcessSampler({
          path: process.env.STATION_MEMORY_SAMPLE_PATH,
          signalSnapshots: true,
        });
  const dispose = () => sampler?.dispose();
  process.once("exit", dispose);
  try {
    await runTarget(target);
  } finally {
    process.off("exit", dispose);
    dispose();
  }
}

async function runTarget(target: ProfileTarget): Promise<void> {
  const argv = process.argv.slice(2);
  if (target === "observer") {
    const { runCliObserverMain, runCliObserverProcess } = await import(
      "../../../apps/cli/src/observerMain.js"
    );
    const code = await runCliObserverProcess((startupReadinessSink) =>
      runCliObserverMain(argv, { startupReadinessSink }),
    );
    process.exitCode = code;
    return;
  }
  if (target === "tui") {
    const { runStationMain } = await import("../../../station/src/main.js");
    await runStationMain();
    return;
  }
  if (target === "dashboard") {
    const { runDashboardMain } = await import("../../../station/src/dashboardRenderer/main.js");
    await runDashboardMain();
    return;
  }
  const { runStationHostMain } = await import("../../../station/src/host/hostMain.js");
  await runStationHostMain(argv);
}

function parseTarget(value: string | undefined): ProfileTarget {
  if (value === "observer" || value === "tui" || value === "dashboard" || value === "host") {
    return value;
  }
  throw new Error("STATION_PROFILE_TARGET must be observer, tui, dashboard, or host.");
}

if (import.meta.main) {
  await main();
}
