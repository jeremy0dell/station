import { runStationBinaryMain } from "../../../station/src/bin/stnMain.js";
import { startProcessSampler } from "./processSampler.mjs";

/** Runs the normal compiled Station dispatch with sampling enabled only for an explicit path. */
export async function runProfiledStationBinaryMain(): Promise<void> {
  const outputPath = process.env.STATION_MEMORY_SAMPLE_PATH;
  if (outputPath === undefined || outputPath === "") {
    await runStationBinaryMain();
    return;
  }

  const sampler = await startProcessSampler({ path: outputPath });
  const dispose = () => sampler.dispose();
  process.once("exit", dispose);
  try {
    await runStationBinaryMain();
  } finally {
    process.off("exit", dispose);
    dispose();
  }
}

if (import.meta.main) {
  await runProfiledStationBinaryMain();
}
