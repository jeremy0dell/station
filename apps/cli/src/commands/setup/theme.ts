export type SetupTheme = {
  bold(value: string): string;
  dim(value: string): string;
  cyan(value: string): string;
  green(value: string): string;
  red(value: string): string;
  yellow(value: string): string;
};

export type SetupRenderOptions = {
  color?: boolean;
};

const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  red: "\u001B[31m",
  yellow: "\u001B[33m",
} as const;

export function setupTheme(options: SetupRenderOptions = {}): SetupTheme {
  if (options.color !== true) {
    return {
      bold: identity,
      dim: identity,
      cyan: identity,
      green: identity,
      red: identity,
      yellow: identity,
    };
  }
  return {
    bold: (value) => colorize(ansi.bold, value),
    dim: (value) => colorize(ansi.dim, value),
    cyan: (value) => colorize(ansi.cyan, value),
    green: (value) => colorize(ansi.green, value),
    red: (value) => colorize(ansi.red, value),
    yellow: (value) => colorize(ansi.yellow, value),
  };
}

function identity(value: string): string {
  return value;
}

function colorize(code: string, value: string): string {
  return `${code}${value}${ansi.reset}`;
}
