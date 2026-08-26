import type { CliInvocationOutcome, CliRunAuditMetadata } from "../../src/index.js";

const audit: CliRunAuditMetadata = {
  command: { commandId: "cmd_type", traceId: "trc_type" },
  resources: { sessionId: "ses_type" },
};

const outcome: CliInvocationOutcome = {
  kind: "outcome",
  invocationId: "11111111-1111-4111-8111-111111111111",
  finishedAt: "2026-08-25T12:00:00.000Z",
  durationMs: 10,
  status: "succeeded",
  exitCode: 0,
  resolvedPath: ["session", "get"],
  audit,
};

// @ts-expect-error exactOptionalPropertyTypes keeps absent outcome metadata distinct from undefined.
const explicitUndefinedOutcomeAudit: CliInvocationOutcome = {
  ...outcome,
  audit: undefined,
};

const absentOptional: CliRunAuditMetadata = {};

// @ts-expect-error exactOptionalPropertyTypes keeps absent audit fields distinct from undefined.
const explicitUndefined: CliRunAuditMetadata = {
  command: undefined,
};

const explicitUndefinedTrace: CliRunAuditMetadata = {
  // @ts-expect-error exactOptionalPropertyTypes also applies inside correlation metadata.
  command: { commandId: "cmd_type", traceId: undefined },
};

const explicitUndefinedResource: CliRunAuditMetadata = {
  // @ts-expect-error exactOptionalPropertyTypes also applies inside resource metadata.
  resources: { projectId: undefined },
};

void outcome;
void explicitUndefinedOutcomeAudit;
void absentOptional;
void explicitUndefined;
void explicitUndefinedTrace;
void explicitUndefinedResource;
