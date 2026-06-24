import {
  type CliHelpMode,
  renderCliCommandHelpTopic,
  resolveCliCommandTopic,
} from "./commandRegistry.js";

export type { CliHelpMode };

export type CliHelpResult = {
  mode: CliHelpMode;
  text: string;
};

export function renderCliHelpFromArgs(args: readonly string[]): CliHelpResult | undefined {
  if (!args.some(isCliHelpFlag)) {
    return undefined;
  }
  const mode: CliHelpMode = args.includes("--man") ? "man" : "help";
  const topicPath = helpTopicPath(args.filter((arg) => !isCliHelpFlag(arg)));
  return {
    mode,
    text: renderCliCommandHelpTopic(topicPath, mode),
  };
}

export function renderCliHelpTopic(path: readonly string[], mode: CliHelpMode): string {
  return renderCliCommandHelpTopic(path, mode);
}

export function isCliHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "--man";
}

function helpTopicPath(args: readonly string[]): readonly string[] {
  let best: readonly string[] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const prefix = args.slice(0, index + 1);
    if (resolveCliCommandTopic(prefix) !== undefined) {
      best = prefix;
    }
  }
  return best ?? args;
}
