import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ADAPTER
 *
 * Renders the generated `station-agent-state.js` plugin body from
 * `pluginScriptBody.js` with install-time values JSON-encoded into the
 * `__STATION_*__` placeholder tokens.
 */

export type StationOpenCodePluginScriptInput = {
  observerSocketPath: string;
  stateDir: string;
  hookSpoolDir: string;
  forwardedEventTypes: readonly string[];
};

/**
 * Compiled binaries embed the body as an asset; source runs read the checked-in
 * file beside this module. The compiled binary sets this env var to the asset
 * path so `stn hooks install opencode` renders the same body everywhere.
 */
const compiledBodyPath = process.env.STATION_OPENCODE_PLUGIN_BODY_PATH;

const stationOpenCodePluginBody = readFileSync(
  compiledBodyPath !== undefined && compiledBodyPath.length > 0
    ? compiledBodyPath
    : fileURLToPath(new URL("../pluginScriptBody.js", import.meta.url)),
  "utf8",
);

const STATION_OPENCODE_PLUGIN_TOKENS = {
  socketPath: "__STATION_SOCKET_PATH__",
  stateDir: "__STATION_STATE_DIR__",
  spoolDir: "__STATION_SPOOL_DIR__",
  forwardedEventTypes: "__STATION_FORWARDED_EVENT_TYPES__",
} as const;

/**
 * ADAPTER
 *
 * Renders the plugin body with install-time values JSON-encoded into the
 * placeholder tokens, so the generated artifact stays valid standalone JS.
 */
export function renderStationOpenCodePlugin(input: StationOpenCodePluginScriptInput): string {
  return stationOpenCodePluginBody
    .replaceAll(STATION_OPENCODE_PLUGIN_TOKENS.socketPath, JSON.stringify(input.observerSocketPath))
    .replaceAll(STATION_OPENCODE_PLUGIN_TOKENS.stateDir, JSON.stringify(input.stateDir))
    .replaceAll(STATION_OPENCODE_PLUGIN_TOKENS.spoolDir, JSON.stringify(input.hookSpoolDir))
    .replaceAll(
      STATION_OPENCODE_PLUGIN_TOKENS.forwardedEventTypes,
      JSON.stringify(input.forwardedEventTypes),
    );
}
