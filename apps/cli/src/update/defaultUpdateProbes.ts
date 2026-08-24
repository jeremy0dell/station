import {
  type ExternalCommandRunner,
  type StationBuildInfo,
  stationBuildInfo,
} from "@station/runtime";
import type { CliEnv } from "../env.js";
import { createUpdateChannelProbe, type UpdateChannelProbe } from "./channelDetection.js";
import { createDevCheckoutUpdateChannel } from "./devCheckoutUpdate.js";
import { createHomebrewUpdateChannel } from "./homebrewUpdate.js";
import { createInstallerBinaryUpdateChannel } from "./installerBinaryUpdate.js";
import { createMiseUpdateChannel } from "./miseUpdate.js";
import { createNpmGlobalUpdateChannel } from "./npmGlobalUpdate.js";

/**
 * COMPOSITION ROOT
 *
 * Chooses concrete channel adapters. A supplied build is the caller's invocation capture;
 * otherwise this standalone composition captures one value for every build-aware probe.
 */
export function createDefaultUpdateProbes(
  options: { cliEntryPath: string; env?: CliEnv },
  deps: {
    buildInfo?: StationBuildInfo;
    executablePath?: string;
    commandRunner?: ExternalCommandRunner;
  } = {},
): UpdateChannelProbe[] {
  const capturedBuildInfo = deps.buildInfo ?? stationBuildInfo();
  const buildInfo = () => capturedBuildInfo;
  const runtimePath = deps.executablePath ?? process.execPath;
  const shared = {
    runtimePath,
    ...(options.env?.PATH === undefined ? {} : { pathEnv: options.env.PATH }),
    ...(deps.commandRunner === undefined ? {} : { commandRunner: deps.commandRunner }),
  };
  return [
    createUpdateChannelProbe(
      createInstallerBinaryUpdateChannel({
        buildInfo,
        ...(deps.executablePath === undefined ? {} : { executablePath: deps.executablePath }),
        ...(deps.commandRunner === undefined ? {} : { commandRunner: deps.commandRunner }),
      }),
    ),
    createUpdateChannelProbe(
      createDevCheckoutUpdateChannel({
        cliEntryPath: options.cliEntryPath,
        buildInfo,
        ...shared,
      }),
    ),
    createUpdateChannelProbe(createHomebrewUpdateChannel(shared)),
    createUpdateChannelProbe(createNpmGlobalUpdateChannel(shared)),
    createUpdateChannelProbe(createMiseUpdateChannel(shared)),
  ];
}
