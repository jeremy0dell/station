import type { SupportedHarnessId } from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";

export function resolveSetupHarnessInstallation(input: {
  readonly harnessId: SupportedHarnessId;
  readonly brewAvailable: boolean;
  readonly homeDir: string;
  readonly macos: boolean;
}) {
  const macBrewAvailable = input.macos && input.brewAvailable;
  switch (input.harnessId) {
    case "codex":
      return macBrewAvailable
        ? {
            command: ["brew", "install", "--cask", "homebrew/cask/codex"],
            message: setupMessageRef("installer.codex-brew"),
          }
        : {
            command: ["/bin/bash", "-c", codexInstallerCommand],
            message: setupMessageRef("installer.codex-script"),
          };
    case "cursor":
      return {
        command: [
          "/bin/bash",
          "-c",
          downloadedInstallerCommand({ url: "https://cursor.com/install" }),
        ],
        message: setupMessageRef("installer.cursor-script"),
      };
    case "opencode":
      return input.brewAvailable
        ? {
            command: ["brew", "install", "homebrew/core/opencode"],
            message: setupMessageRef("installer.opencode-brew"),
          }
        : {
            command: [
              "/bin/bash",
              "-c",
              downloadedInstallerCommand({
                url: "https://opencode.ai/install",
                execute:
                  '/bin/bash "$installer" --no-modify-path && mkdir -p "$HOME/.local/bin" && ln -s "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"',
              }),
            ],
            message: setupMessageRef("installer.opencode-script"),
          };
    case "pi":
      return input.brewAvailable
        ? {
            command: ["brew", "install", "homebrew/core/pi-coding-agent"],
            message: setupMessageRef("installer.pi-brew"),
          }
        : {
            command: [
              "npm",
              "install",
              "--global",
              "--prefix",
              `${input.homeDir}/.local`,
              "--ignore-scripts",
              "--no-fund",
              "--no-audit",
              "@earendil-works/pi-coding-agent",
            ],
            message: setupMessageRef("installer.pi-npm"),
          };
    case "claude":
      return macBrewAvailable
        ? {
            command: ["brew", "install", "--cask", "homebrew/cask/claude-code"],
            message: setupMessageRef("installer.claude-brew"),
          }
        : {
            command: [
              "npm",
              "install",
              "--global",
              "--prefix",
              `${input.homeDir}/.local`,
              "--no-fund",
              "--no-audit",
              "@anthropic-ai/claude-code",
            ],
            message: setupMessageRef("installer.claude-npm"),
          };
  }
}

const codexInstallerCommand = [
  "set -eu",
  'installer="$(mktemp)"',
  'installer_home="$(mktemp -d)"',
  'cleanup() { rm -f "$installer"; rm -rf "$installer_home"; }',
  "trap cleanup EXIT",
  'curl -fsSL https://chatgpt.com/codex/install.sh -o "$installer"',
  'station_user_home="$HOME"',
  `station_codex_home="\${CODEX_HOME:-$station_user_home/.codex}"`,
  'HOME="$installer_home" CODEX_HOME="$station_codex_home" CODEX_INSTALL_DIR="$station_user_home/.local/bin" CODEX_NON_INTERACTIVE=1 /bin/sh "$installer"',
].join("; ");

function downloadedInstallerCommand(input: { readonly url: string; readonly execute?: string }) {
  return [
    "set -eu",
    'installer="$(mktemp)"',
    "trap 'rm -f \"$installer\"' EXIT",
    `curl -fsSL ${input.url} -o "$installer"`,
    input.execute ?? '/bin/bash "$installer"',
  ].join("; ");
}
