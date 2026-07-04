import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { resolvePath } from "./observerPaths.js";

export type ObserverProcessArgs = {
  configPath?: string;
  socketPath?: string;
  stateDir?: string;
};

/** Mirrors runObserverMain's parseArgs so a candidate's socket resolves identically. */
export function parseObserverProcessArgs(argv: readonly string[]): ObserverProcessArgs {
  const result: ObserverProcessArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (value === undefined) continue;
    if (arg === "--config") {
      result.configPath = value;
      index += 1;
    } else if (arg === "--socket") {
      result.socketPath = value;
      index += 1;
    } else if (arg === "--state-dir") {
      result.stateDir = value;
      index += 1;
    }
  }
  return result;
}

const ObserverTomlSectionSchema = z
  .object({ state_dir: z.string().optional(), socket_path: z.string().optional() })
  .passthrough();

export type ResolveObserverSocketDeps = {
  homeDir?: string;
  xdgRuntimeDir?: string | undefined;
  readFile?: (path: string) => string;
};

/**
 * The socket path a process WOULD bind, derived from its argv the same way
 * runObserverMain does (`--socket` > config `socket_path` > XDG > stateDir/run).
 * Returns undefined when it cannot be determined — the reaper must never target
 * a process whose socket it cannot positively resolve (fail closed).
 */
export function resolveObserverSocketForProcessArgs(
  argv: readonly string[],
  deps: ResolveObserverSocketDeps = {},
): string | undefined {
  const home = deps.homeDir ?? homedir();
  const args = parseObserverProcessArgs(argv);

  let section: { stateDir?: string; socketPath?: string } = {};
  // Only read the config when no explicit --socket already pins the path.
  if (args.socketPath === undefined && args.configPath !== undefined) {
    const read = readObserverTomlSection(args.configPath, deps.readFile);
    if (read === undefined) return undefined;
    section = read;
  }

  if (args.socketPath !== undefined) return resolvePath(args.socketPath, home);
  if (section.socketPath !== undefined) return resolvePath(section.socketPath, home);

  const xdg = deps.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR;
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "station", "observer.sock");

  const stateDir = resolvePath(args.stateDir ?? section.stateDir ?? "~/.local/state/station", home);
  return join(stateDir, "run", "observer.sock");
}

function readObserverTomlSection(
  configPath: string,
  readFile?: (path: string) => string,
): { stateDir?: string; socketPath?: string } | undefined {
  let text: string;
  try {
    text = (readFile ?? ((path) => readFileSync(path, "utf8")))(configPath);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("observer" in parsed)) {
    return {};
  }
  const result = ObserverTomlSectionSchema.safeParse((parsed as Record<string, unknown>).observer);
  if (!result.success) return {};
  const section: { stateDir?: string; socketPath?: string } = {};
  if (result.data.state_dir !== undefined) section.stateDir = result.data.state_dir;
  if (result.data.socket_path !== undefined) section.socketPath = result.data.socket_path;
  return section;
}
