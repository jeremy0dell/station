import type { ExternalCommandRunner } from "@station/runtime";
import type { TmuxCommandInput } from "../command.js";
import { tmuxProviderErrorFromUnknown } from "../errors.js";
import { type ClaimedPopupActionResult, runClaimedPopupAction } from "./display.js";
import {
  buildPopupActiveClaim,
  createPopupProtocolNonce,
  type PopupActiveClaim,
} from "./fastProtocol.js";
import type { TmuxPopupScopeDescriptor } from "./scope.js";
import {
  clearActivePopupClaimIfCurrent,
  clearLegacyFocusIfUnclaimed,
  compareAndSetActivePopupClaim,
  dismissLegacyPopupIfUnclaimed,
  resolveActivePopupClaimState,
  resolveActivePopupClient,
  resolveFocusPopupClient,
  type TmuxActivePopupClaimState,
} from "./state.js";
import type { TmuxClientIdentity, TmuxPersistentPopupUi } from "./types.js";

export type PopupOwnershipAcquisition =
  | { kind: "closed" }
  | { claim: string; kind: "claimed"; previousClientId?: string }
  | { kind: "legacy"; previousClientId?: string }
  | { kind: "untracked" };

export type AcquirePopupOwnershipInput = {
  command: string;
  currentClient?: TmuxClientIdentity;
  focusClientId?: string;
  persistentUi?: TmuxPersistentPopupUi;
  registrationNonce?: string;
  runner?: ExternalCommandRunner;
  scope: TmuxPopupScopeDescriptor;
  tmuxCommand: TmuxCommandInput;
};

export type CloseClaimedPopupInput = Pick<
  AcquirePopupOwnershipInput,
  "command" | "runner" | "scope" | "tmuxCommand"
> & {
  claim: PopupActiveClaim;
  expectedClaim: string;
};

export type DismissPopupOwnershipInput = Pick<
  AcquirePopupOwnershipInput,
  "command" | "runner" | "scope" | "tmuxCommand"
> & {
  expectedClaim?: string;
  focusClientId?: string;
};

type ClaimPopupOwnershipInput = AcquirePopupOwnershipInput & {
  currentClient: TmuxClientIdentity;
  focusClientId: string;
};

type ClaimAttemptResult =
  | Extract<PopupOwnershipAcquisition, { kind: "claimed" | "closed" }>
  | { kind: "failed" | "retry" };

type CloseClaimedPopupResult = "closed" | "contended";

type DismissClaimAttemptResult =
  | { kind: "absent" }
  | { kind: "dismissed" }
  | { boundClaim: string; kind: "retry" }
  | { kind: "unavailable" };

function popupClaimContention(): never {
  throw tmuxProviderErrorFromUnknown(new Error("tmux popup claim contention"), {
    code: "TERMINAL_OPEN_FAILED",
    message: "tmux failed to claim the station popup.",
  });
}

function claimClientIdentity(input: ClaimPopupOwnershipInput): TmuxClientIdentity {
  return {
    ...input.currentClient,
    name: input.focusClientId,
  };
}

function isCurrentPopupOwner(
  input: ClaimPopupOwnershipInput,
  claimState: Extract<TmuxActivePopupClaimState, { kind: "valid" }>,
  claimClient: TmuxClientIdentity,
): boolean {
  const sameClient =
    claimState.claim.clientName === input.focusClientId &&
    claimState.claim.clientPid === claimClient.pid;
  const nestedClient =
    input.persistentUi !== undefined && claimClient.sessionName === input.persistentUi.sessionName;
  return sameClient || nestedClient;
}

async function closeUnclaimedPopupForCurrentClient(
  input: ClaimPopupOwnershipInput,
  claimClient: TmuxClientIdentity,
  registrationNonce: string,
): Promise<CloseClaimedPopupResult> {
  const closingClaim = buildPopupActiveClaim({
    clientName: claimClient.name,
    clientPid: claimClient.pid,
    registrationNonce,
    state: "closing",
  });
  const claimed = await compareAndSetActivePopupClaim(
    input.tmuxCommand,
    { replacement: closingClaim },
    input.scope.state,
  );
  if (!claimed) {
    return "contended";
  }
  return closeClaimedPopupAction(input, closingClaim, claimClient);
}

async function closeClaimedPopupAction(
  input: ClaimPopupOwnershipInput,
  closingClaim: string,
  claimClient: TmuxClientIdentity,
): Promise<CloseClaimedPopupResult> {
  let actionResult: ClaimedPopupActionResult | undefined;
  try {
    actionResult = await runClaimedPopupAction({
      args: ["display-popup", "-c", claimClient.name, "-C"],
      claim: closingClaim,
      clientId: claimClient.name,
      command: input.command,
      state: input.scope.state,
      ...(input.runner === undefined ? {} : { runner: input.runner }),
    });
  } finally {
    if (actionResult !== "contended") {
      await clearActivePopupClaimIfCurrent(
        input.tmuxCommand,
        { claim: closingClaim, clientId: claimClient.name },
        input.scope.state,
      ).catch(() => undefined);
    }
  }
  return actionResult === "contended" ? "contended" : "closed";
}

function nextOpenClaim(input: {
  claimClient: TmuxClientIdentity;
  claimState: TmuxActivePopupClaimState;
  fallbackRegistrationNonce: string;
  registrationNonce?: string;
}): string {
  const registrationNonce =
    input.registrationNonce ??
    (input.claimState.kind === "valid"
      ? input.claimState.claim.registrationNonce
      : input.fallbackRegistrationNonce);
  return buildPopupActiveClaim({
    clientName: input.claimClient.name,
    clientPid: input.claimClient.pid,
    registrationNonce,
    state: "open",
  });
}

async function closeCurrentOwnedClaim(
  input: ClaimPopupOwnershipInput,
  claimClient: TmuxClientIdentity,
  claimState: TmuxActivePopupClaimState,
): Promise<ClaimAttemptResult | undefined> {
  if (claimState.kind !== "valid" || !isCurrentPopupOwner(input, claimState, claimClient)) {
    return undefined;
  }
  const closeInput: CloseClaimedPopupInput = {
    command: input.command,
    claim: claimState.claim,
    expectedClaim: claimState.raw,
    scope: input.scope,
    tmuxCommand: input.tmuxCommand,
  };
  if (input.runner !== undefined) closeInput.runner = input.runner;
  const result = await closeClaimedPopup(closeInput);
  return { kind: result === "contended" ? "retry" : "closed" };
}

async function replacePopupClaim(input: {
  activeClientId?: string;
  claimClient: TmuxClientIdentity;
  claimInput: ClaimPopupOwnershipInput;
  claimState: TmuxActivePopupClaimState;
  fallbackRegistrationNonce: string;
}): Promise<ClaimAttemptResult> {
  const claimOptions: Parameters<typeof nextOpenClaim>[0] = {
    claimClient: input.claimClient,
    claimState: input.claimState,
    fallbackRegistrationNonce: input.fallbackRegistrationNonce,
  };
  if (input.claimInput.registrationNonce !== undefined) {
    claimOptions.registrationNonce = input.claimInput.registrationNonce;
  }
  const claim = nextOpenClaim(claimOptions);
  const replacement: { expected?: string; replacement: string } = { replacement: claim };
  if (input.claimState.kind !== "absent") replacement.expected = input.claimState.raw;
  const replaced = await compareAndSetActivePopupClaim(
    input.claimInput.tmuxCommand,
    replacement,
    input.claimInput.scope.state,
  );
  if (!replaced) return { kind: "retry" };

  const previousClientId =
    input.claimState.kind === "valid" ? input.claimState.claim.clientName : input.activeClientId;
  const acquired: Extract<PopupOwnershipAcquisition, { kind: "claimed" }> = {
    claim,
    kind: "claimed",
  };
  if (previousClientId !== undefined) acquired.previousClientId = previousClientId;
  return acquired;
}

async function attemptPopupClaim(
  input: ClaimPopupOwnershipInput,
  claimClient: TmuxClientIdentity,
  fallbackRegistrationNonce: string,
): Promise<ClaimAttemptResult> {
  const claimState = await resolveActivePopupClaimState(input.tmuxCommand, input.scope.state);
  if (claimState.kind === "malformed" && claimState.raw.length > 4096) {
    return { kind: "failed" };
  }

  const currentClose = await closeCurrentOwnedClaim(input, claimClient, claimState);
  if (currentClose !== undefined) return currentClose;

  const activeClientId = await resolveActivePopupClient(input.tmuxCommand, input.scope.state);
  if (claimState.kind === "absent" && activeClientId === input.focusClientId) {
    const result = await closeUnclaimedPopupForCurrentClient(
      input,
      claimClient,
      input.registrationNonce ?? fallbackRegistrationNonce,
    );
    return { kind: result === "contended" ? "retry" : "closed" };
  }
  return replacePopupClaim({
    claimClient,
    claimInput: input,
    claimState,
    fallbackRegistrationNonce,
    ...(activeClientId === undefined ? {} : { activeClientId }),
  });
}

async function acquireClaimedPopupOwnership(
  input: ClaimPopupOwnershipInput,
): Promise<PopupOwnershipAcquisition> {
  const claimClient = claimClientIdentity(input);
  const fallbackRegistrationNonce = createPopupProtocolNonce();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await attemptPopupClaim(input, claimClient, fallbackRegistrationNonce);
    if (result.kind === "claimed" || result.kind === "closed") return result;
    if (result.kind === "failed") break;
  }
  return popupClaimContention();
}

async function attemptClaimedPopupDismissal(
  input: DismissPopupOwnershipInput,
  boundClaim: string | undefined,
): Promise<DismissClaimAttemptResult> {
  const claimState = await resolveActivePopupClaimState(input.tmuxCommand, input.scope.state);
  if (
    claimState.kind === "malformed" ||
    (claimState.kind === "valid" && claimState.claim.state !== "open")
  ) {
    return { kind: "unavailable" };
  }
  if (boundClaim !== undefined && (claimState.kind !== "valid" || claimState.raw !== boundClaim)) {
    return { kind: "unavailable" };
  }
  if (claimState.kind === "absent") {
    return { kind: "absent" };
  }

  const closeInput: CloseClaimedPopupInput = {
    command: input.command,
    claim: claimState.claim,
    expectedClaim: claimState.raw,
    scope: input.scope,
    tmuxCommand: input.tmuxCommand,
  };
  if (input.runner !== undefined) closeInput.runner = input.runner;
  const result = await closeClaimedPopup(closeInput);
  return result === "contended"
    ? { boundClaim: claimState.raw, kind: "retry" }
    : { kind: "dismissed" };
}

async function acquireLegacyPopupOwnership(
  input: AcquirePopupOwnershipInput & { focusClientId: string },
): Promise<PopupOwnershipAcquisition> {
  const claimState = await resolveActivePopupClaimState(input.tmuxCommand, input.scope.state);
  if (claimState.kind !== "absent") {
    return popupClaimContention();
  }
  const activeClientId = await resolveActivePopupClient(input.tmuxCommand, input.scope.state);
  if (activeClientId === input.focusClientId) {
    await dismissLegacyPopupIfUnclaimed(
      { ...input.tmuxCommand, clientId: input.focusClientId },
      input.scope.state,
    );
    return { kind: "closed" };
  }
  return {
    kind: "legacy",
    ...(activeClientId === undefined ? {} : { previousClientId: activeClientId }),
  };
}

export async function closeClaimedPopup(
  input: CloseClaimedPopupInput,
): Promise<CloseClaimedPopupResult> {
  const closingClaim = buildPopupActiveClaim({
    clientName: input.claim.clientName,
    clientPid: input.claim.clientPid,
    registrationNonce: input.claim.registrationNonce,
    state: "closing",
  });
  const claimed = await compareAndSetActivePopupClaim(
    input.tmuxCommand,
    {
      expected: input.expectedClaim,
      replacement: closingClaim,
    },
    input.scope.state,
  );
  if (!claimed) {
    return "contended";
  }

  let actionResult: ClaimedPopupActionResult | undefined;
  try {
    actionResult = await runClaimedPopupAction({
      args: ["display-popup", "-c", input.claim.clientName, "-C"],
      claim: closingClaim,
      clientId: input.claim.clientName,
      command: input.command,
      state: input.scope.state,
      ...(input.runner === undefined ? {} : { runner: input.runner }),
    });
  } finally {
    if (actionResult !== "contended") {
      await clearActivePopupClaimIfCurrent(
        input.tmuxCommand,
        {
          claim: closingClaim,
          clientId: input.claim.clientName,
        },
        input.scope.state,
      ).catch(() => undefined);
    }
  }
  return actionResult === "contended" ? "contended" : "closed";
}

export async function dismissPopupOwnership(input: DismissPopupOwnershipInput): Promise<boolean> {
  let boundClaim = input.expectedClaim;
  let contended = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await attemptClaimedPopupDismissal(input, boundClaim);
    if (result.kind === "dismissed") return true;
    if (result.kind === "unavailable") return false;
    if (result.kind === "absent") break;
    boundClaim = result.boundClaim;
    contended = true;
  }
  if (contended || boundClaim !== undefined || !input.scope.allowLegacyState) {
    return false;
  }
  const clientId =
    input.focusClientId ??
    (await resolveFocusPopupClient(input.tmuxCommand, input.scope.state)) ??
    (await resolveActivePopupClient(input.tmuxCommand, input.scope.state));
  if (clientId === undefined) return false;
  return dismissLegacyPopupIfUnclaimed({ ...input.tmuxCommand, clientId }, input.scope.state);
}

export async function acquirePopupOwnership(
  input: AcquirePopupOwnershipInput,
): Promise<PopupOwnershipAcquisition> {
  if (input.focusClientId !== undefined && input.currentClient !== undefined) {
    return acquireClaimedPopupOwnership({
      ...input,
      currentClient: input.currentClient,
      focusClientId: input.focusClientId,
    });
  }
  if (input.focusClientId !== undefined) {
    if (!input.scope.allowLegacyState) {
      return popupClaimContention();
    }
    return acquireLegacyPopupOwnership({ ...input, focusClientId: input.focusClientId });
  }
  if (input.scope.allowLegacyState) {
    const legacyFocusClientId = await resolveFocusPopupClient(input.tmuxCommand, input.scope.state);
    if (legacyFocusClientId !== undefined) {
      await clearLegacyFocusIfUnclaimed(
        { ...input.tmuxCommand, clientId: legacyFocusClientId },
        input.scope.state,
      ).catch(() => undefined);
    }
  }
  return { kind: "untracked" };
}
