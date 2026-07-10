import { basename } from "node:path";
import { isCompiledBinary } from "@station/runtime";

export type SelfExecTarget =
  | "cli"
  | "observer"
  | "ingress"
  | "tui"
  | "dashboard"
  | "station-host"
  | "tmux-popup";

/** An executable plus fixed prefix arguments; callers append operation-specific arguments. */
export type ExecutableArgv = readonly [command: string, ...prefixArgs: string[]];

export type SelfExecRuntime = {
  compiled: boolean;
  execPath: string;
};

const COMPILED_PREFIX_ARGS = {
  cli: [],
  observer: ["__observer"],
  ingress: ["__ingress"],
  tui: ["__tui"],
  dashboard: ["__dashboard"],
  "station-host": ["__station-host"],
  "tmux-popup": ["__tmux-popup"],
} as const satisfies Record<SelfExecTarget, readonly string[]>;

/**
 * Returns the source command unchanged or a compiled self-reexec prefix.
 * Invocation-specific arguments are not appended.
 */
export function selfExecArgv(
  target: SelfExecTarget,
  developmentArgv: ExecutableArgv,
  runtime?: SelfExecRuntime,
): ExecutableArgv {
  const resolvedRuntime = runtime ?? {
    compiled: isCompiledBinary(),
    execPath: process.execPath,
  };

  if (!resolvedRuntime.compiled) return developmentArgv;
  return [resolvedRuntime.execPath, ...COMPILED_PREFIX_ARGS[target]];
}

/**
 * Raw process runners that own their I/O and exit semantics.
 * They are injected so CLI dispatch does not import Station or OpenTUI.
 */
export type SelfExecRunners = {
  cli(argv: readonly string[]): void | Promise<void>;
  observer(argv: readonly string[]): void | Promise<void>;
  ingress(argv: readonly string[]): void | Promise<void>;
  tui(argv: readonly string[]): void | Promise<void>;
  dashboard(argv: readonly string[]): void | Promise<void>;
  stationHost(argv: readonly string[]): void | Promise<void>;
  tmuxPopup(argv: readonly string[]): void | Promise<void>;
};

/**
 * Routes argv0 ingress before consuming one exact internal first token.
 * Dispatch occurs before CLI parsing or stdin reads; all other argv reaches the CLI unchanged.
 */
export async function dispatchSelfExec(
  input: { argv0: string; argv: readonly string[] },
  runners: SelfExecRunners,
): Promise<void> {
  if (basename(input.argv0) === "stn-ingress") {
    await runners.ingress(input.argv);
    return;
  }

  switch (input.argv[0]) {
    case "__observer":
      await runners.observer(input.argv.slice(1));
      return;
    case "__ingress":
      await runners.ingress(input.argv.slice(1));
      return;
    case "__tui":
      await runners.tui(input.argv.slice(1));
      return;
    case "__dashboard":
      await runners.dashboard(input.argv.slice(1));
      return;
    case "__station-host":
      await runners.stationHost(input.argv.slice(1));
      return;
    case "__tmux-popup":
      await runners.tmuxPopup(input.argv.slice(1));
      return;
    default:
      await runners.cli(input.argv);
  }
}
