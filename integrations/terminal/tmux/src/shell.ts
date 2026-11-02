import * as runtime from "@station/runtime";

export function shellQuote(value: string): string {
  return runtime.shellQuote(value, true);
}

export const safeShellTokenPattern = /^[A-Za-z0-9_@%+=,./:-]+$/;
