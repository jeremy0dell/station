import type { SetupOperation } from "../model/operations.js";
import type { SetupOperationOutcome, SetupOperationPorts } from "../ports.js";

export async function performSetupOperation(
  operation: SetupOperation,
  ports: SetupOperationPorts,
): Promise<SetupOperationOutcome> {
  switch (operation.kind) {
    case "write-config":
      return ports.config(operation);
    case "activate-observer-config":
      return ports.observer(operation);
    case "prepare-harness-tracking":
      return ports.harnessTracking(operation);
    case "prepare-worktrunk-tracking":
    case "configure-worktrunk-shell":
      return ports.worktrunk(operation);
    case "configure-tmux-popup":
      return ports.tmux(operation);
    case "install-tool":
    case "install-harness":
    case "install-homebrew":
    case "install-xcode-command-line-tools":
      return ports.packages(operation);
    case "link-launchers":
      return ports.launchers(operation);
  }
}
