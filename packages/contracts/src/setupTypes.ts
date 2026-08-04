import { z } from "zod";

export const CliSetupHarnessIdSchema = z.enum(["codex", "cursor", "opencode", "pi", "claude"]);

export const CliSetupCheckSchema = z
  .object({
    id: z.string().min(1),
    tier: z.enum(["required", "recommended", "optional"]),
    status: z.enum(["ok", "missing", "warning", "skipped"]),
    label: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const CliSetupActionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["brew-install", "run-command", "write-config", "append-file", "mkdir", "noop"]),
    tier: z.enum(["required", "recommended", "optional"]),
    selected: z.boolean(),
    label: z.string().min(1),
    message: z.string().min(1),
    command: z.array(z.string()).optional(),
    path: z.string().optional(),
    status: z.enum(["pending", "completed", "failed", "skipped"]).optional(),
    data: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const CliSetupSummarySchema = z
  .object({
    launchReady: z.boolean(),
    workflowReady: z.boolean(),
    requiredOk: z.boolean(),
    requiredMissing: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    selectedActions: z.number().int().nonnegative(),
    selectionSource: z.enum(["configured", "explicit", "inferred", "unresolved"]),
    selectedHarness: CliSetupHarnessIdSchema.optional(),
    configPath: z.string(),
  })
  .strict()
  .refine((summary) => summary.requiredOk === summary.workflowReady, {
    path: ["requiredOk"],
    message: "requiredOk must match workflowReady",
  });

export const CliSetupPlanSchema = z
  .object({
    generatedAt: z.string().min(1),
    mode: z.enum(["check", "plan", "apply"]),
    checks: z.array(CliSetupCheckSchema),
    actions: z.array(CliSetupActionSchema),
    summary: CliSetupSummarySchema,
    nextSteps: z.array(z.string()),
  })
  .strict();

export type CliSetupCheck = z.infer<typeof CliSetupCheckSchema>;
export type CliSetupAction = z.infer<typeof CliSetupActionSchema>;
export type CliSetupPlan = z.infer<typeof CliSetupPlanSchema>;
