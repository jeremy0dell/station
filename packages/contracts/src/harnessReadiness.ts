import { z } from "zod";
import { ProviderIdSchema, TimestampSchema } from "./ids.js";
import { nonEmptyStringSchema, safeTextSchema } from "./shared.js";

export const HarnessCatalogKindSchema = z.enum(["built_in", "configured_custom"]);
export const HarnessConfigurationSchema = z.enum([
  "configured",
  "not_configured",
  "disabled",
  "unknown",
]);
export const HarnessCliSchema = z.enum(["available", "missing", "unknown"]);
export const HarnessAuthenticationSchema = z.enum([
  "ready",
  "required",
  "not_applicable",
  "unknown",
]);
export const HarnessLaunchabilitySchema = z.enum(["ready", "blocked", "unknown"]);
export const HarnessProviderTrackingSetupSchema = z.enum([
  "prepared",
  "needs_preparation",
  "repair_needed",
  "unsupported",
  "unknown",
]);
export const HarnessTrackingSchema = z.enum([
  "observed",
  "prepared_unverified",
  "needs_preparation",
  "repair_needed",
  "unsupported",
  "unknown",
]);
export const HarnessReadinessFreshnessSchema = z.enum(["fresh", "stale", "checking", "failed"]);
export const HarnessReadinessActionSchema = z.enum([
  "use",
  "prepare",
  "repair",
  "sign_in",
  "install_cli",
  "check_again",
  "technical_details",
]);
export const HarnessReadinessDecisionSchema = z.enum([
  "launch_ready",
  "prepare_then_launch",
  "blocked_user_action",
  "unknown",
]);
export const HarnessReadinessCompactStatusSchema = z.enum([
  "ready",
  "prepared",
  "needs_setup",
  "repair",
  "sign_in",
  "not_installed",
  "checking",
  "unknown",
]);

export type HarnessCatalogKind = z.infer<typeof HarnessCatalogKindSchema>;
export type HarnessConfiguration = z.infer<typeof HarnessConfigurationSchema>;
export type HarnessCli = z.infer<typeof HarnessCliSchema>;
export type HarnessAuthentication = z.infer<typeof HarnessAuthenticationSchema>;
export type HarnessLaunchability = z.infer<typeof HarnessLaunchabilitySchema>;
export type HarnessProviderTrackingSetup = z.infer<typeof HarnessProviderTrackingSetupSchema>;
export type HarnessTracking = z.infer<typeof HarnessTrackingSchema>;
export type HarnessReadinessFreshness = z.infer<typeof HarnessReadinessFreshnessSchema>;
export type HarnessReadinessAction = z.infer<typeof HarnessReadinessActionSchema>;
export type HarnessReadinessDecision = z.infer<typeof HarnessReadinessDecisionSchema>;
export type HarnessReadinessCompactStatus = z.infer<typeof HarnessReadinessCompactStatusSchema>;

export const HarnessReadinessTechnicalDetailSchema = z
  .object({
    code: nonEmptyStringSchema,
    message: safeTextSchema,
  })
  .strict();

export type HarnessReadinessTechnicalDetail = z.infer<typeof HarnessReadinessTechnicalDetailSchema>;

const harnessReadinessFactsSharedShape = {
  authentication: HarnessAuthenticationSchema,
  launchability: HarnessLaunchabilitySchema,
  trackingSetup: HarnessProviderTrackingSetupSchema,
  latestVersion: nonEmptyStringSchema.optional(),
  technicalDetails: z.array(HarnessReadinessTechnicalDetailSchema),
};

export const HarnessReadinessFactsSchema = z.discriminatedUnion("cli", [
  z
    .object({
      ...harnessReadinessFactsSharedShape,
      cli: z.literal("available"),
      installedVersion: nonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...harnessReadinessFactsSharedShape,
      cli: z.literal("missing"),
    })
    .strict(),
  z
    .object({
      ...harnessReadinessFactsSharedShape,
      cli: z.literal("unknown"),
    })
    .strict(),
]);

export type HarnessReadinessFacts = z.infer<typeof HarnessReadinessFactsSchema>;

export type HarnessReadinessProbeContext = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const HarnessReadinessSummarySchema = z
  .object({
    status: HarnessReadinessCompactStatusSchema,
    freshness: HarnessReadinessFreshnessSchema,
    decision: HarnessReadinessDecisionSchema,
    revision: nonEmptyStringSchema,
    checkedAt: TimestampSchema.optional(),
  })
  .strict();

export type HarnessReadinessSummary = z.infer<typeof HarnessReadinessSummarySchema>;

const harnessReadinessSharedShape = {
  provider: ProviderIdSchema,
  label: nonEmptyStringSchema,
  kind: HarnessCatalogKindSchema,
  configuration: HarnessConfigurationSchema,
  authentication: HarnessAuthenticationSchema,
  launchability: HarnessLaunchabilitySchema,
  trackingSetup: HarnessProviderTrackingSetupSchema,
  tracking: HarnessTrackingSchema,
  latestVersion: nonEmptyStringSchema.optional(),
  freshness: HarnessReadinessFreshnessSchema,
  decision: HarnessReadinessDecisionSchema,
  revision: nonEmptyStringSchema,
  checkedAt: TimestampSchema.optional(),
  explanation: safeTextSchema,
  actions: z.array(HarnessReadinessActionSchema),
  technicalDetails: z.array(HarnessReadinessTechnicalDetailSchema),
};

export const HarnessReadinessSchema = z.discriminatedUnion("cli", [
  z
    .object({
      ...harnessReadinessSharedShape,
      cli: z.literal("available"),
      installedVersion: nonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...harnessReadinessSharedShape,
      cli: z.literal("missing"),
    })
    .strict(),
  z
    .object({
      ...harnessReadinessSharedShape,
      cli: z.literal("unknown"),
    })
    .strict(),
]);

export type HarnessReadiness = z.infer<typeof HarnessReadinessSchema>;

export const HarnessCatalogEntrySchema = z
  .object({
    id: ProviderIdSchema,
    label: nonEmptyStringSchema,
    kind: HarnessCatalogKindSchema,
    configuration: HarnessConfigurationSchema,
    readiness: HarnessReadinessSummarySchema,
  })
  .strict();

export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntrySchema>;

export const HarnessReadinessQueryParamsSchema = z
  .object({
    provider: ProviderIdSchema,
    refresh: z.boolean().optional(),
  })
  .strict();

export type HarnessReadinessQueryParams = z.infer<typeof HarnessReadinessQueryParamsSchema>;

export const HarnessReadinessQueryResultSchema = z
  .object({
    readiness: HarnessReadinessSchema,
  })
  .strict();

export type HarnessReadinessQueryResult = z.infer<typeof HarnessReadinessQueryResultSchema>;
