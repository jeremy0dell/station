import {
  type ExternalCommandRunner,
  runExternalCommand,
  runRuntimeBoundaryWithRetry,
} from "@station/runtime";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { shellQuote } from "../shell.js";
import { isSafePopupClientName } from "./fastProtocol.js";
import type { TmuxPopupStateKeys } from "./scope.js";

export type PopupDisplayResult = "opened" | "dismissed";
export type ClaimedPopupActionResult = PopupDisplayResult | "contended";

export type PopupDisplayInput = {
  args: string[];
  command: string;
  runner?: ExternalCommandRunner;
};

export type ClaimedPopupActionInput = PopupDisplayInput & {
  claim: string;
  clientId: string;
  previousClientId?: string;
  state: TmuxPopupStateKeys;
};

type GuardedPopupActionInput = PopupDisplayInput & {
  clientId: string;
  condition: string;
  previousClientId?: string;
  state: TmuxPopupStateKeys;
};

const popupCasMiss = "STATION_POPUP_CAS_MISS";
const safeTmuxCommandTokenPattern = /^[A-Za-z0-9_@%+=,./:-]+$/;

function tmuxFormatLiteral(value: string): string {
  return value.replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
}

function nestedTmuxCommand(args: readonly string[]): string {
  return args
    .map((arg) => {
      const escaped = arg.replaceAll("#", "##");
      return safeTmuxCommandTokenPattern.test(escaped) ? escaped : shellQuote(escaped);
    })
    .join(" ");
}

async function runGuardedPopupAction(
  input: GuardedPopupActionInput,
): Promise<ClaimedPopupActionResult> {
  if (
    !isSafePopupClientName(input.clientId) ||
    (input.previousClientId !== undefined && !isSafePopupClientName(input.previousClientId))
  ) {
    throw tmuxProviderErrorFromUnknown(new Error("unsafe tmux popup client"), {
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux failed to open the station popup.",
    });
  }
  const action = [
    nestedTmuxCommand(["set-option", "-gq", input.state.activeClientOption, input.clientId]),
    nestedTmuxCommand(["set-option", "-gq", input.state.focusClientOption, input.clientId]),
    ...(input.previousClientId === undefined || input.previousClientId === input.clientId
      ? []
      : [nestedTmuxCommand(["display-popup", "-c", input.previousClientId, "-C"])]),
    nestedTmuxCommand(input.args),
  ].join(" ; ");
  const result = await runRuntimeBoundaryWithRetry(
    {
      operation: "provider.tmux.popup.guardedAction",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_POPUP_FAILED",
        message: "tmux failed to open the station popup.",
        provider: "tmux",
      },
      retry: { retries: 0 },
    },
    ({ signal }) =>
      runExternalCommand(
        {
          command: input.command,
          args: ["if-shell", "-F", input.condition, action, `display-message -p ${popupCasMiss}`],
          signal,
          maxOutputChars: 64 * 1024,
          allowedExitCodes: [0, 129],
        },
        input.runner,
      ),
  );
  if (!result.ok) {
    throw tmuxProviderErrorFromUnknown(result.error, {
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux failed to open the station popup.",
    });
  }
  if (result.value.stdout.trim() === popupCasMiss) {
    return "contended";
  }
  return result.value.exitCode === 129 ? "dismissed" : "opened";
}

export async function runPopupDisplay(input: PopupDisplayInput): Promise<PopupDisplayResult> {
  const result = await runRuntimeBoundaryWithRetry(
    {
      operation: "provider.tmux.popup",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_POPUP_FAILED",
        message: "tmux failed to open the station popup.",
        provider: "tmux",
      },
      retry: { retries: 0 },
    },
    ({ signal }) =>
      runExternalCommand(
        {
          command: input.command,
          args: input.args,
          signal,
          maxOutputChars: 64 * 1024,
          allowedExitCodes: [0, 129],
        },
        input.runner,
      ),
  );

  if (!result.ok) {
    throw tmuxProviderErrorFromUnknown(result.error, {
      code: "TERMINAL_OPEN_FAILED",
      message: "tmux failed to open the station popup.",
    });
  }

  return result.value.exitCode === 129 ? "dismissed" : "opened";
}

export function runClaimedPopupAction(
  input: ClaimedPopupActionInput,
): Promise<ClaimedPopupActionResult> {
  return runGuardedPopupAction({
    ...input,
    condition: `#{==:#{${input.state.activeClaimOption}},${tmuxFormatLiteral(input.claim)}}`,
  });
}

export function runUnclaimedPopupAction(
  input: Omit<GuardedPopupActionInput, "condition">,
): Promise<ClaimedPopupActionResult> {
  return runGuardedPopupAction({
    ...input,
    condition: `#{&&:#{==:#{${input.state.activeClaimOption}},},#{==:#{${input.state.activeClientOption}},${tmuxFormatLiteral(input.previousClientId ?? "")}}}`,
  });
}
