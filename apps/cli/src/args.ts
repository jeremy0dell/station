export class CliInputError extends Error {
  readonly tag = "CliInputError" as const;
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.tag;
    this.code = code;
  }
}

export function parsePositiveIntegerOption(value: string | undefined, option: string): number {
  if (value === undefined) {
    throw new CliInputError("CLI_OPTION_VALUE_REQUIRED", `${option} requires a value.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliInputError(
      "CLI_OPTION_POSITIVE_INTEGER_REQUIRED",
      `${option} must be a positive integer.`,
    );
  }
  return parsed;
}

export function parseRequiredOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new CliInputError("CLI_OPTION_VALUE_REQUIRED", `${option} requires a value.`);
  }
  return value;
}
