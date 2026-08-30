export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJson(value: string): unknown {
  return JSON.parse(value);
}
