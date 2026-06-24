export function parsePositiveIntegerOption(value: string | undefined, option: string): number {
  if (value === undefined) {
    throw new Error(`${option} requires a value.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

export function parseRequiredOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}
