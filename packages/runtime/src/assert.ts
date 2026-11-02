export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled value: ${String(value)}`);
}
