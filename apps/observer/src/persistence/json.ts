export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function optionalJson(value: unknown): string | null {
  return value === undefined ? null : stringifyJson(value);
}

export function parseJson(value: string): unknown {
  return JSON.parse(value);
}

export function maxIso(left: string | undefined, right: string): string {
  if (left === undefined) {
    return right;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
