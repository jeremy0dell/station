import type { StationConfig } from "@station/config";
import type { TerminalCallerContextRequest } from "@station/contracts";
import type { ProcessEvidence } from "@station/runtime";

export type SessionCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
  caller?: () => TerminalCallerContextRequest;
  processEvidence?: ProcessEvidence;
  environment?: Readonly<Record<string, string | undefined>>;
  captureCallerClaims?: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Record<string, string>;
};

export type SessionCommandDeps = Pick<
  SessionCommandOptions,
  "caller" | "captureCallerClaims" | "environment" | "processEvidence"
>;
