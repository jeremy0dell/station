import { resolveSetupMessage, setupMessageRef } from "@station/setup-messages";
import { createSetupComposition } from "../composition.js";
import type { SetupAction } from "../model.js";
import { runGuidedSetupSession } from "../session/runGuidedSetupSession.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "../types.js";

/** Compatibility entrypoint retained until the legacy guided modules are removed in #358. */
export function runGuidedSetup(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SetupCommandResult> {
  return runGuidedSetupSession(options, (guidedOptions, operationProgress, initialIntent) =>
    createSetupComposition({
      mode: "apply",
      options: guidedOptions,
      deps,
      noBrew: false,
      planConfigWrite: true,
      initialIntent,
      operationProgress,
    }),
  );
}

/** Compatibility action fixture retained until legacy apply coverage moves in #358. */
export function homebrewInstallAction(): SetupAction {
  return {
    id: "install-homebrew",
    kind: "run-command",
    tier: "required",
    selected: true,
    label: resolveSetupMessage(setupMessageRef("action.install-label", { label: "Homebrew" })),
    message: resolveSetupMessage(setupMessageRef("installer.homebrew")),
    command: [
      "/bin/bash",
      "-c",
      [
        "set -eu",
        'installer="$(mktemp)"',
        "trap 'rm -f \"$installer\"' EXIT",
        'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"',
        '/bin/bash "$installer"',
      ].join("; "),
    ],
  };
}
