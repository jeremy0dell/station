import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

declare const STATION_BUILD_OPENCODE_PLUGIN_BODY: string;

/**
 * ADAPTER
 *
 * Renders the generated `station-agent-state.js` plugin body from the checked-in source body or
 * its compiled-binary embedding, with install-time values JSON-encoded into `__STATION_*__`
 * placeholder tokens.
 */

export type StationOpenCodePluginScriptInput = {
  observerSocketPath: string;
  stateDir: string;
  hookSpoolDir: string;
  forwardedEventTypes: readonly string[];
};

// Binary compilation replaces this identifier with the checked-in body; source execution reads
// the same file beside dist without exporting a process-global asset path to child processes.
const stationOpenCodePluginBody =
  typeof STATION_BUILD_OPENCODE_PLUGIN_BODY === "undefined"
    ? readFileSync(fileURLToPath(new URL("../pluginScriptBody.js", import.meta.url)), "utf8")
    : STATION_BUILD_OPENCODE_PLUGIN_BODY;

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
