import { spawn } from "node:child_process";

export type OpenUrlCommand = {
  command: string;
  args: string[];
};

/**
 * Snapshot URLs are untrusted: open only http(s), never through a shell. Windows
 * uses rundll32 FileProtocolHandler so cmd metacharacters cannot be re-parsed.
 */
export function openExternalUrl(rawUrl: string): void {
  const command = resolveOpenUrlCommand(process.platform, rawUrl);
  if (command === undefined) return;
  try {
    const child = spawn(command.command, command.args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort: no platform opener is available.
  }
}

export function resolveOpenUrlCommand(
  platform: string,
  rawUrl: string,
): OpenUrlCommand | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  const href = url.toString();
  switch (platform) {
    case "darwin":
      return { command: "open", args: [href] };
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
    case "linux":
    case "freebsd":
    case "openbsd":
    case "netbsd":
      return { command: "xdg-open", args: [href] };
    default:
      return undefined;
  }
}
