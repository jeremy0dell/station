import type { SetupCommandDeps, SetupPromptAdapter } from "../../src/commands/setup/types.js";

type SetupReadFile = (path: string) => Promise<string>;

export function configBackedHarnessHooksProbe(
  readFile: SetupReadFile,
): NonNullable<SetupCommandDeps["probeHarnessHooksStatus"]> {
  return async (harnessId, configPath) => {
    if (harnessId === "pi") return undefined;
    let source = "";
    try {
      source = await readFile(configPath);
    } catch {
      source = "";
    }
    const block = setupHarnessBlock(source, harnessId);
    const requested = /(?:^|\n)install_hooks\s*=\s*true(?:\n|$)/.test(block);
    return {
      provider: harnessId,
      requested,
      installed: requested,
      missing: requested ? [] : ["tracking artifact"],
      message: requested ? "Tracking artifacts are installed." : "Tracking is disabled.",
    };
  };
}

export function withRequiredTrackingConsent(prompt: SetupPromptAdapter): SetupPromptAdapter {
  return {
    ...prompt,
    confirm: (message) =>
      message.includes("Station requires tracking")
        ? Promise.resolve(true)
        : prompt.confirm(message),
  };
}

function setupHarnessBlock(source: string, harnessId: string): string {
  const marker = `[harness.${harnessId}]`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const contentStart = start + marker.length;
  const end = source.indexOf("\n[", contentStart);
  return source.slice(contentStart, end < 0 ? source.length : end);
}
