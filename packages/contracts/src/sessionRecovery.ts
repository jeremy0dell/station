import { z } from "zod";
import { type ProviderId, ProviderIdSchema, TimestampSchema } from "./ids.js";
import type { SessionRecoveryHandle } from "./recovery.js";
import { nonEmptyStringSchema, userFacingTitleSchema } from "./shared.js";

export const SessionRecoveryHarnessReadinessSchema = z
  .object({
    provider: ProviderIdSchema,
    canResume: z.boolean(),
  })
  .strict();

export const SessionRecoveryReadinessSchema = z
  .object({
    resumeEnabled: z.boolean(),
    canonicalTitleImport: z.literal(true).optional(),
    managedTerminal: z
      .object({
        provider: ProviderIdSchema,
        canLaunchProcessPersistently: z.boolean(),
      })
      .strict()
      .optional(),
    harnesses: z.array(SessionRecoveryHarnessReadinessSchema),
  })
  .strict();

export type SessionRecoveryReadiness = z.infer<typeof SessionRecoveryReadinessSchema>;

export const SessionRescueObserverPathsSchema = z
  .object({
    stateDir: nonEmptyStringSchema,
    socketPath: nonEmptyStringSchema,
    dbPath: nonEmptyStringSchema,
    logDir: nonEmptyStringSchema,
    diagnosticsDir: nonEmptyStringSchema,
    hookSpoolDir: nonEmptyStringSchema,
  })
  .strict();

export const SessionRescueMetadataSchema = z
  .object({
    configPath: nonEmptyStringSchema,
    codexHome: nonEmptyStringSchema,
    claudeProjectsRoot: nonEmptyStringSchema.optional(),
    opencodeDb: nonEmptyStringSchema,
    observerPaths: SessionRescueObserverPathsSchema,
    hostSocketPath: nonEmptyStringSchema,
    stationVersion: nonEmptyStringSchema,
    stationBuildIdentity: nonEmptyStringSchema,
    observerBuildVersion: nonEmptyStringSchema,
  })
  .strict();

export const SessionRescueManifestEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      path: nonEmptyStringSchema,
      type: z.literal("file"),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
  z
    .object({
      path: nonEmptyStringSchema,
      type: z.literal("symlink"),
      target: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
]);

export const SessionRescueManifestSchema = z
  .object({
    archiveVersion: z.literal(1),
    createdAt: TimestampSchema,
    status: z.enum(["complete", "partial"]),
    warnings: z.array(z.string()),
    critical: z.array(z.string()),
    metadata: SessionRescueMetadataSchema,
    files: z.array(SessionRescueManifestEntrySchema),
  })
  .strict();

export const SessionRecoveryCoverageSchema = z.array(
  z
    .object({
      sessionId: nonEmptyStringSchema,
      provider: ProviderIdSchema,
      projectId: nonEmptyStringSchema,
      worktreeId: nonEmptyStringSchema,
      terminalTargetId: nonEmptyStringSchema.optional(),
      ptyId: nonEmptyStringSchema.optional(),
      exactHandleIds: z.array(nonEmptyStringSchema),
      candidateHandleIds: z.array(nonEmptyStringSchema),
    })
    .strict(),
);

export const SessionMigrationLockSchema = z
  .object({
    pid: z.number().int().positive(),
    token: z.uuid(),
    createdAt: TimestampSchema,
  })
  .strict();

export const SessionMigrationSealSchema = z
  .object({
    sealedAt: TimestampSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    sessions: z.array(nonEmptyStringSchema),
    files: z.array(SessionRescueManifestEntrySchema),
  })
  .strict();

export const SessionMigrationJournalEntrySchema = z
  .object({
    at: TimestampSchema,
    phase: nonEmptyStringSchema,
    status: z.enum(["started", "complete", "failed", "interrupted"]),
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    sealedRoot: nonEmptyStringSchema.optional(),
    sessionId: nonEmptyStringSchema.optional(),
    titleEvidence: z
      .array(
        z
          .object({
            sessionId: nonEmptyStringSchema,
            sourceTitle: userFacingTitleSchema,
            targetTitle: userFacingTitleSchema,
          })
          .strict(),
      )
      .optional(),
    error: nonEmptyStringSchema.optional(),
  })
  .strict();

/**
 * DRIVEN PORT
 *
 * Locates provider-owned files required to recover one exact native execution
 * without exposing provider storage conventions to migration orchestration.
 */
export interface SessionRecoveryArtifactLocator {
  readonly provider: ProviderId;
  protectedRoots(): readonly string[];
  locate(handle: SessionRecoveryHandle): Promise<readonly string[]>;
}
