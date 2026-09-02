export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const safeShellTokenPattern = /^[A-Za-z0-9_@%+=,./:-]+$/;
