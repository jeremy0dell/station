export type SetupLink = {
  readonly label: string;
  readonly url: string;
};

export type SetupTheme = {
  bold(value: string): string;
  dim(value: string): string;
  cyan(value: string): string;
  green(value: string): string;
  red(value: string): string;
  yellow(value: string): string;
  link(input: SetupLink): string;
};

export type SetupRenderOptions = {
  color?: boolean;
  hyperlinks?: boolean;
};

const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  red: "\u001B[31m",
  yellow: "\u001B[33m",
  underline: "\u001B[4m",
} as const;

const osc8Close = "\u001B]8;;\u001B\\";

export function setupTheme(options: SetupRenderOptions = {}): SetupTheme {
  if (options.color !== true) {
    return {
      bold: identity,
      dim: identity,
      cyan: identity,
      green: identity,
      red: identity,
      yellow: identity,
      link: (input) => terminalLink({ ...input, enabled: options.hyperlinks === true }),
    };
  }
  return {
    bold: (value) => colorize({ code: ansi.bold, value }),
    dim: (value) => colorize({ code: ansi.dim, value }),
    cyan: (value) => colorize({ code: ansi.cyan, value }),
    green: (value) => colorize({ code: ansi.green, value }),
    red: (value) => colorize({ code: ansi.red, value }),
    yellow: (value) => colorize({ code: ansi.yellow, value }),
    link: (input) =>
      colorize({
        code: `${ansi.cyan}${ansi.underline}`,
        value: terminalLink({ ...input, enabled: options.hyperlinks === true }),
      }),
  };
}

function identity(value: string): string {
  return value;
}

function colorize(input: { readonly code: string; readonly value: string }): string {
  return `${input.code}${input.value}${ansi.reset}`;
}

function terminalLink(input: SetupLink & { readonly enabled: boolean }): string {
  if (!input.enabled) return `${input.label} (${input.url})`;
  // OSC 8 keeps the visible source label compact while preserving its destination.
  return `\u001B]8;;${input.url}\u001B\\${input.label}${osc8Close}`;
}
