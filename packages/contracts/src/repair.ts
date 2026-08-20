import { z } from "zod";
import { type SafeError, SafeErrorSchema } from "./errors.js";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";

export const RepairSchemaVersionSchema = z.literal(1);
export const RepairSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const RepairCommandArgvSchema = z.tuple([nonEmptyStringSchema], z.string());

export type RepairCommandArgv = readonly [command: string, ...args: string[]];

export const RepairSocketIdentitySchema = z
  .object({
    inode: nonEmptyStringSchema,
    birthtimeNs: nonEmptyStringSchema,
  })
  .strict();
export type RepairSocketIdentity = z.infer<typeof RepairSocketIdentitySchema>;

export const RepairProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    startToken: nonEmptyStringSchema,
    executablePath: nonEmptyStringSchema,
    argv: z.array(z.string()).min(1),
  })
  .strict();
export type RepairProcessIdentity = z.infer<typeof RepairProcessIdentitySchema>;

export const RepairRuntimeOwnershipSchema = z
  .object({
    component: z.enum(["observer", "host"]),
    status: z.enum(["absent", "verified", "stale", "unavailable", "uncertain"]),
    socketPath: nonEmptyStringSchema,
    socketIdentity: RepairSocketIdentitySchema.optional(),
    holderPids: z.array(z.number().int().positive()),
    process: RepairProcessIdentitySchema.optional(),
    buildVersion: nonEmptyStringSchema.optional(),
    protocolVersion: z.number().int().optional(),
    refusalCode: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((ownership, context) => {
    if (!strictlySortedNumbers(ownership.holderPids)) {
      issue(context, ["holderPids"], "Socket holder PIDs must be unique and sorted.");
    }
    if (
      ownership.status === "verified" &&
      (ownership.socketIdentity === undefined ||
        ownership.holderPids.length !== 1 ||
        ownership.process === undefined ||
        ownership.holderPids[0] !== ownership.process.pid)
    ) {
      issue(
        context,
        ["status"],
        "Verified ownership requires one matching holder, socket identity, and process identity.",
      );
    }
    if (ownership.status === "absent" && ownership.holderPids.length > 0) {
      issue(context, ["holderPids"], "Absent ownership cannot carry socket holders.");
    }
  });
export type RepairRuntimeOwnership = z.infer<typeof RepairRuntimeOwnershipSchema>;

export const RepairProcessGroupMemberSchema = z
  .object({
    pid: z.number().int().positive(),
    processGroupId: z.number().int().positive(),
    sessionId: z.number().int().positive(),
    tty: nonEmptyStringSchema,
    startToken: nonEmptyStringSchema,
  })
  .strict();
export type RepairProcessGroupMember = z.infer<typeof RepairProcessGroupMemberSchema>;

export const RepairTerminalGroupSchema = z
  .object({
    targetKey: nonEmptyStringSchema,
    disposition: z.enum(["verified", "non-recoverable", "refused"]),
    kind: z.enum(["agent", "aux"]),
    hostSocketIdentity: RepairSocketIdentitySchema,
    hostProcess: RepairProcessIdentitySchema,
    hostBuildVersion: nonEmptyStringSchema,
    hostProtocolVersion: z.number().int(),
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: nonEmptyStringSchema,
    terminalTargetId: TerminalTargetIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    stationSessionId: SessionIdSchema,
    harnessProvider: ProviderIdSchema,
    childPid: z.number().int().positive(),
    processGroupId: z.number().int().positive(),
    terminalSessionId: z.number().int().positive(),
    tty: nonEmptyStringSchema,
    leaderStartToken: nonEmptyStringSchema,
    members: z.array(RepairProcessGroupMemberSchema).min(1),
    refusalCode: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (!strictlySortedNumbers(target.members.map((member) => member.pid))) {
      issue(context, ["members"], "Process-group members must be unique and sorted by PID.");
    }
    if (
      target.disposition === "verified" &&
      target.members.some(
        (member) =>
          member.processGroupId !== target.processGroupId ||
          member.sessionId !== target.terminalSessionId ||
          member.tty !== target.tty,
      )
    ) {
      issue(context, ["members"], "Every member must match the selected terminal topology.");
    }
    if (target.kind === "aux" && target.disposition !== "non-recoverable") {
      issue(context, ["disposition"], "Auxiliary PTYs are never repair targets.");
    }
    if (target.disposition === "refused" && target.refusalCode === undefined) {
      issue(context, ["refusalCode"], "Refused terminal groups require a refusal code.");
    }
  });
export type RepairTerminalGroup = z.infer<typeof RepairTerminalGroupSchema>;

export const RepairRetainedSessionSchema = z
  .object({
    id: SessionIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    lifecycle: z.enum(["legacy", "open", "ended"]),
    harnessProvider: ProviderIdSchema.optional(),
    terminalProvider: ProviderIdSchema.optional(),
    createdAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    endedAt: TimestampSchema.optional(),
  })
  .strict();
export type RepairRetainedSession = z.infer<typeof RepairRetainedSessionSchema>;

export const RepairRecoveryHandleDispositionSchema = z.enum([
  "viable",
  "ended-session",
  "missing-session",
  "session-mismatch",
  "worktree-mismatch",
  "provider-mismatch",
  "unsupported-provider",
]);
export type RepairRecoveryHandleDisposition = z.infer<typeof RepairRecoveryHandleDispositionSchema>;

/** Redacted recovery evidence; provider-native targets and local paths never cross this boundary. */
export const RepairRecoveryHandleSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: ProviderIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    sessionId: SessionIdSchema.optional(),
    targetKind: z.enum(["native-session", "session-file"]),
    observedAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    disposition: RepairRecoveryHandleDispositionSchema,
    eligible: z.boolean(),
    reasonCode: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((handle, context) => {
    if (handle.eligible !== (handle.disposition === "viable")) {
      issue(context, ["eligible"], "Only viable recovery handles can be eligible.");
    }
  });
export type RepairRecoveryHandle = z.infer<typeof RepairRecoveryHandleSchema>;

export const RepairFindingSchema = z
  .object({
    severity: z.enum(["info", "warning", "blocker"]),
    code: nonEmptyStringSchema,
    message: safeTextSchema,
    targetKey: nonEmptyStringSchema.optional(),
    recoveryCommands: z.array(RepairCommandArgvSchema),
  })
  .strict();
export type RepairFinding = z.infer<typeof RepairFindingSchema>;

export const ObserverRepairInventorySchema = z
  .object({
    schemaVersion: RepairSchemaVersionSchema,
    sessions: z.array(RepairRetainedSessionSchema),
    recoveryHandles: z.array(RepairRecoveryHandleSchema),
  })
  .strict()
  .superRefine((inventory, context) => {
    sortedUniqueBy(inventory.sessions, (session) => session.id, context, ["sessions"]);
    sortedUniqueBy(inventory.recoveryHandles, (handle) => handle.id, context, ["recoveryHandles"]);
  });
export type ObserverRepairInventory = z.infer<typeof ObserverRepairInventorySchema>;

export const RepairInventorySchema = z
  .object({
    schemaVersion: RepairSchemaVersionSchema,
    capturedAt: TimestampSchema,
    inventoryDigest: RepairSha256Schema,
    completeness: z.enum(["complete", "partial"]),
    observer: RepairRuntimeOwnershipSchema,
    host: RepairRuntimeOwnershipSchema,
    terminalGroups: z.array(RepairTerminalGroupSchema),
    sessions: z.array(RepairRetainedSessionSchema),
    recoveryHandles: z.array(RepairRecoveryHandleSchema),
    findings: z.array(RepairFindingSchema),
  })
  .strict()
  .superRefine((inventory, context) => {
    if (inventory.observer.component !== "observer") {
      issue(context, ["observer", "component"], "Observer evidence must identify the Observer.");
    }
    if (inventory.host.component !== "host") {
      issue(context, ["host", "component"], "Host evidence must identify the Host.");
    }
    sortedUniqueBy(inventory.terminalGroups, (target) => target.targetKey, context, [
      "terminalGroups",
    ]);
    sortedUniqueBy(inventory.sessions, (session) => session.id, context, ["sessions"]);
    sortedUniqueBy(inventory.recoveryHandles, (handle) => handle.id, context, ["recoveryHandles"]);
    sortedUniqueBy(
      inventory.findings,
      (finding) => `${finding.severity}:${finding.code}:${finding.targetKey ?? ""}`,
      context,
      ["findings"],
    );
    if (
      inventory.completeness === "complete" &&
      inventory.findings.some((finding) => finding.severity === "blocker")
    ) {
      issue(context, ["completeness"], "A complete inventory cannot contain blockers.");
    }
  });
export type RepairInventory = z.infer<typeof RepairInventorySchema>;

export const RepairTargetReferenceSchema = z
  .object({
    targetKey: nonEmptyStringSchema,
    kind: z.literal("agent"),
    hostSocketIdentity: RepairSocketIdentitySchema,
    hostProcess: RepairProcessIdentitySchema,
    hostBuildVersion: nonEmptyStringSchema,
    hostProtocolVersion: z.number().int(),
    ptyId: nonEmptyStringSchema,
    ptyInstanceId: nonEmptyStringSchema,
    terminalTargetId: TerminalTargetIdSchema,
    projectId: ProjectIdSchema,
    worktreeId: WorktreeIdSchema,
    stationSessionId: SessionIdSchema,
    harnessProvider: ProviderIdSchema,
    childPid: z.number().int().positive(),
    processGroupId: z.number().int().positive(),
    terminalSessionId: z.number().int().positive(),
    tty: nonEmptyStringSchema,
    leaderStartToken: nonEmptyStringSchema,
    members: z.array(RepairProcessGroupMemberSchema).min(1),
  })
  .strict();
export type RepairTargetReference = z.infer<typeof RepairTargetReferenceSchema>;

export const RuntimeRepairDryRunRequestSchema = z
  .object({
    schemaVersion: RepairSchemaVersionSchema,
    dryRun: z.literal(true),
    expectInventory: RepairSha256Schema,
    targetKeys: z.array(nonEmptyStringSchema).min(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (!strictlySortedStrings(request.targetKeys)) {
      issue(context, ["targetKeys"], "Runtime target keys must be unique and sorted.");
    }
  });
export type RuntimeRepairDryRunRequest = z.infer<typeof RuntimeRepairDryRunRequestSchema>;

export const RecoveryRepairDryRunRequestSchema = z
  .object({
    schemaVersion: RepairSchemaVersionSchema,
    dryRun: z.literal(true),
    expectInventory: RepairSha256Schema,
    sessionId: SessionIdSchema,
    keepHandleId: nonEmptyStringSchema.optional(),
    pruneHandleIds: z.array(nonEmptyStringSchema),
  })
  .strict()
  .superRefine((request, context) => {
    if (!strictlySortedStrings(request.pruneHandleIds)) {
      issue(context, ["pruneHandleIds"], "Pruned handle IDs must be unique and sorted.");
    }
    if (
      request.keepHandleId !== undefined &&
      request.pruneHandleIds.includes(request.keepHandleId)
    ) {
      issue(context, ["pruneHandleIds"], "The explicitly kept handle cannot be pruned.");
    }
  });
export type RecoveryRepairDryRunRequest = z.infer<typeof RecoveryRepairDryRunRequestSchema>;

export const RepairPlannedActionSchema = z
  .object({
    order: z.number().int().positive(),
    action: z.enum([
      "reinventory",
      "drain-terminal",
      "reap-process-group",
      "verify-runtime",
      "validate-recovery-handle",
      "keep-recovery-handle",
      "prune-recovery-handle",
    ]),
    targetKey: nonEmptyStringSchema,
    target: RepairTargetReferenceSchema.optional(),
    handle: RepairRecoveryHandleSchema.optional(),
  })
  .strict()
  .superRefine((action, context) => {
    const runtime = action.action === "drain-terminal" || action.action === "reap-process-group";
    const recovery =
      action.action === "validate-recovery-handle" ||
      action.action === "keep-recovery-handle" ||
      action.action === "prune-recovery-handle";
    if (runtime !== (action.target !== undefined)) {
      issue(context, ["target"], "Terminal actions require exact target evidence only.");
    }
    if (recovery !== (action.handle !== undefined)) {
      issue(context, ["handle"], "Recovery actions require redacted handle evidence only.");
    }
  });
export type RepairPlannedAction = z.infer<typeof RepairPlannedActionSchema>;

export const RepairPreviewReportSchema = z
  .object({
    schemaVersion: RepairSchemaVersionSchema,
    mode: z.literal("preview"),
    action: z.enum(["runtime", "recovery"]),
    status: z.enum(["planned", "refused"]),
    inventoryDigest: RepairSha256Schema,
    planDigest: RepairSha256Schema,
    selectedTargets: z.array(nonEmptyStringSchema),
    plannedActions: z.array(RepairPlannedActionSchema),
    blockers: z.array(SafeErrorSchema),
    warnings: z.array(SafeErrorSchema),
    recoveryCommands: z.array(RepairCommandArgvSchema),
  })
  .strict()
  .superRefine((report, context) => {
    if (!strictlySortedStrings(report.selectedTargets)) {
      issue(context, ["selectedTargets"], "Selected targets must be unique and sorted.");
    }
    const orders = report.plannedActions.map((action) => action.order);
    if (orders.some((order, index) => order !== index + 1)) {
      issue(context, ["plannedActions"], "Planned actions must have contiguous ordered steps.");
    }
    if ((report.status === "refused") !== report.blockers.length > 0) {
      issue(context, ["status"], "Only refused previews carry blockers.");
    }
  });
export type RepairPreviewReport = z.infer<typeof RepairPreviewReportSchema>;

export const PersistenceBackupReceiptSchema = z
  .object({
    path: nonEmptyStringSchema,
    createdAt: TimestampSchema,
    sha256: RepairSha256Schema,
    byteSize: z.number().int().nonnegative(),
    sourceSchema: nonEmptyStringSchema,
  })
  .strict();
export type PersistenceBackupReceipt = z.infer<typeof PersistenceBackupReceiptSchema>;

export const RepairTargetOutcomeSchema = z
  .object({
    targetKey: nonEmptyStringSchema,
    status: z.enum(["planned", "applied", "skipped", "refused", "failed"]),
    error: SafeErrorSchema.optional(),
  })
  .strict();
export type RepairTargetOutcome = z.infer<typeof RepairTargetOutcomeSchema>;

export type RepairAuditResult = {
  schemaVersion: 1;
  auditId: string;
  mode: "preview" | "apply";
  action: "runtime" | "recovery";
  status: "planned" | "completed" | "partial" | "refused" | "failed";
  beforeDigest: string;
  finalDigest: string;
  targets: RepairTargetOutcome[];
  backup?: PersistenceBackupReceipt;
  errors: SafeError[];
  warnings: SafeError[];
  recoveryCommands: RepairCommandArgv[];
};

export const RepairAuditResultSchema: z.ZodType<RepairAuditResult> = z
  .object({
    schemaVersion: RepairSchemaVersionSchema,
    auditId: nonEmptyStringSchema,
    mode: z.enum(["preview", "apply"]),
    action: z.enum(["runtime", "recovery"]),
    status: z.enum(["planned", "completed", "partial", "refused", "failed"]),
    beforeDigest: RepairSha256Schema,
    finalDigest: RepairSha256Schema,
    targets: z.array(RepairTargetOutcomeSchema),
    backup: PersistenceBackupReceiptSchema.optional(),
    errors: z.array(SafeErrorSchema),
    warnings: z.array(SafeErrorSchema),
    recoveryCommands: z.array(RepairCommandArgvSchema),
  })
  .strict()
  .superRefine((result, context) => {
    sortedUniqueBy(result.targets, (target) => target.targetKey, context, ["targets"]);
    if (
      result.mode === "preview" &&
      (result.backup !== undefined ||
        result.status === "completed" ||
        result.status === "partial" ||
        result.targets.some((target) => target.status === "applied" || target.status === "skipped"))
    ) {
      issue(context, ["mode"], "Preview audits cannot claim mutation or persistence backup.");
    }
    if (
      result.mode === "apply" &&
      result.action === "recovery" &&
      result.targets.some((target) => target.status === "applied") &&
      result.backup === undefined
    ) {
      issue(
        context,
        ["backup"],
        "Applied recovery-handle mutations require a verified persistence backup.",
      );
    }
  })
  .transform(
    (result): RepairAuditResult => ({
      schemaVersion: result.schemaVersion,
      auditId: result.auditId,
      mode: result.mode,
      action: result.action,
      status: result.status,
      beforeDigest: result.beforeDigest,
      finalDigest: result.finalDigest,
      targets: result.targets,
      ...(result.backup === undefined ? {} : { backup: result.backup }),
      errors: result.errors,
      warnings: result.warnings,
      recoveryCommands: result.recoveryCommands,
    }),
  );

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}

function strictlySortedStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as string) < value);
}

function strictlySortedNumbers(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as number) < value);
}

function sortedUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (!strictlySortedStrings(values.map(key))) {
    issue(context, path, "Entries must be unique and deterministically sorted.");
  }
}
