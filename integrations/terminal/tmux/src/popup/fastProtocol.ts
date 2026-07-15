import { createHash, randomBytes } from "node:crypto";

export type NormalPopupRoute = {
  kind: "normal";
  registrationNonce: string;
  rootSha256: string;
  sessionSha256: string;
  signatureSha256: string;
};

export type PopupActiveClaim = {
  actionNonce: string;
  clientName: string;
  clientPid: number;
  registrationNonce: string;
  state: "open" | "closing";
};

const sha256Pattern = /^[0-9a-f]{64}$/;
const noncePattern = /^[0-9a-f]{32}$/;
const clientNamePattern = /^[A-Za-z0-9_/@%+=:-]{1,128}$/;
const routePattern = /^v1\.n\.([0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{32})$/;
const activeClaimPattern =
  /^v1\.(open|closing)\.([0-9a-f]{32})\.([0-9a-f]{32})\.([1-9][0-9]{0,9})\.([A-Za-z0-9_/@%+=:-]{1,128})$/;
const maximumClientPid = 2_147_483_647;

export function popupProtocolSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPopupProtocolNonce(): string {
  return randomBytes(16).toString("hex");
}

export function buildNormalPopupRoute(options: {
  registrationNonce?: string;
  root: string;
  sessionName: string;
  signature: string;
}): string {
  const registrationNonce = options.registrationNonce ?? createPopupProtocolNonce();
  if (!noncePattern.test(registrationNonce)) {
    throw new Error("Station popup registration nonce must be 128-bit lowercase hexadecimal.");
  }
  return [
    "v1",
    "n",
    popupProtocolSha256(options.root),
    popupProtocolSha256(options.sessionName),
    popupProtocolSha256(options.signature),
    registrationNonce,
  ].join(".");
}

export function parseNormalPopupRoute(value: string): NormalPopupRoute | undefined {
  const match = routePattern.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, rootSha256, sessionSha256, signatureSha256, registrationNonce] = match;
  if (
    rootSha256 === undefined ||
    sessionSha256 === undefined ||
    signatureSha256 === undefined ||
    registrationNonce === undefined
  ) {
    return undefined;
  }
  return {
    kind: "normal",
    registrationNonce,
    rootSha256,
    sessionSha256,
    signatureSha256,
  };
}

export function normalPopupRouteMatches(
  route: NormalPopupRoute,
  options: { root: string; sessionName: string; signature: string },
): boolean {
  return (
    sha256Pattern.test(route.rootSha256) &&
    route.rootSha256 === popupProtocolSha256(options.root) &&
    route.sessionSha256 === popupProtocolSha256(options.sessionName) &&
    route.signatureSha256 === popupProtocolSha256(options.signature)
  );
}

export function buildPopupActiveClaim(options: {
  actionNonce?: string;
  clientName: string;
  clientPid: number;
  registrationNonce: string;
  state: "open" | "closing";
}): string {
  const actionNonce = options.actionNonce ?? createPopupProtocolNonce();
  if (!noncePattern.test(options.registrationNonce) || !noncePattern.test(actionNonce)) {
    throw new Error("Station popup claim nonces must be 128-bit lowercase hexadecimal.");
  }
  if (
    !Number.isInteger(options.clientPid) ||
    options.clientPid <= 0 ||
    options.clientPid > maximumClientPid
  ) {
    throw new Error("Station popup client PID is outside the supported range.");
  }
  if (!clientNamePattern.test(options.clientName)) {
    throw new Error("Station popup client name contains unsupported characters.");
  }
  return [
    "v1",
    options.state,
    options.registrationNonce,
    actionNonce,
    String(options.clientPid),
    options.clientName,
  ].join(".");
}

export function parsePopupActiveClaim(value: string): PopupActiveClaim | undefined {
  const match = activeClaimPattern.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, state, registrationNonce, actionNonce, clientPidText, clientName] = match;
  if (
    (state !== "open" && state !== "closing") ||
    registrationNonce === undefined ||
    actionNonce === undefined ||
    clientPidText === undefined ||
    clientName === undefined
  ) {
    return undefined;
  }
  const clientPid = Number(clientPidText);
  if (!Number.isInteger(clientPid) || clientPid <= 0 || clientPid > maximumClientPid) {
    return undefined;
  }
  return {
    actionNonce,
    clientName,
    clientPid,
    registrationNonce,
    state,
  };
}

export function isSafePopupClientName(value: string): boolean {
  return clientNamePattern.test(value);
}
