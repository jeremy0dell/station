import {
  FeatureFlagConfigSchema,
  HarnessPermissionModeSchema,
  ObserverEventHookConfigSchema,
} from "@station/contracts";
import { z } from "zod";
import { DEFAULT_WORKSPACE_CONFIG, WorkspaceConfigSchema } from "./workspace.js";

export {
  type Automation,
  type AutomationStep,
  DEFAULT_WORKSPACE_CONFIG,
  SCROLL_ON_OUTPUT_MODES,
  type ScrollOnOutputMode,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
} from "./workspace.js";

const nonEmptyStringSchema = z.string().min(1);
const providerIdSchema = nonEmptyStringSchema;
const projectIdSchema = nonEmptyStringSchema;

export const ConfigSchemaVersionSchema = z.literal(1);

export const ProjectDefaultsSchema = z
  .object({
    harness: providerIdSchema,
    terminal: providerIdSchema,
    layout: nonEmptyStringSchema,
  })
  .strict();

export type ProjectDefaults = z.infer<typeof ProjectDefaultsSchema>;

export const ProjectLocalDefaultsSchema = ProjectDefaultsSchema.pick({
  harness: true,
  layout: true,
}).partial();

export type ProjectLocalDefaults = z.infer<typeof ProjectLocalDefaultsSchema>;

export const ProjectWorktrunkConfigSchema = z
  .object({
    enabled: z.boolean(),
    base: nonEmptyStringSchema.optional(),
    managedRoot: nonEmptyStringSchema.optional(),
    includeMain: z.boolean().optional(),
    includeExternal: z.boolean().optional(),
  })
  .strict();

export type ProjectWorktrunkConfig = z.infer<typeof ProjectWorktrunkConfigSchema>;

export const ProjectLocalConfigRefSchema = z
  .object({
    enabled: z.boolean(),
    path: nonEmptyStringSchema,
  })
  .strict();

export type ProjectLocalConfigRef = z.infer<typeof ProjectLocalConfigRefSchema>;

export const ProjectDisplayConfigSchema = z
  .object({
    group: nonEmptyStringSchema.optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export type ProjectDisplayConfig = z.infer<typeof ProjectDisplayConfigSchema>;

export const ProjectRecoveryBreadcrumbsSchema = z
  .object({
    location: z.enum(["external", "worktree", "provider-native", "disabled"]),
    path: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ProjectRecoveryBreadcrumbs = z.infer<typeof ProjectRecoveryBreadcrumbsSchema>;

export const ProjectConfigSchema = z
  .object({
    id: projectIdSchema,
    label: nonEmptyStringSchema,
    aliases: z.array(nonEmptyStringSchema).optional(),
    root: nonEmptyStringSchema,
    repo: nonEmptyStringSchema.optional(),
    defaultBranch: nonEmptyStringSchema.optional(),
    defaults: ProjectDefaultsSchema,
    worktrunk: ProjectWorktrunkConfigSchema,
    commands: z.record(nonEmptyStringSchema, nonEmptyStringSchema).optional(),
    env: z.record(nonEmptyStringSchema, z.string()).optional(),
    display: ProjectDisplayConfigSchema.optional(),
    localConfig: ProjectLocalConfigRefSchema.optional(),
    recoveryBreadcrumbs: ProjectRecoveryBreadcrumbsSchema.optional(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ObserverConfigSchema = z
  .object({
    autoStart: z.boolean().optional(),
    autoStartFromHooks: z.boolean().optional(),
    idleShutdownMinutes: z.number().int().positive().optional(),
    reconcileIntervalMs: z.number().int().positive().optional(),
    socketPath: nonEmptyStringSchema.optional(),
    stateDir: nonEmptyStringSchema.optional(),
  })
  .strict();

export type ObserverConfig = z.infer<typeof ObserverConfigSchema>;

export const ConfigDefaultsSchema = z
  .object({
    worktreeProvider: providerIdSchema,
    terminal: providerIdSchema,
    harness: providerIdSchema,
    layout: nonEmptyStringSchema,
    defaultBranch: nonEmptyStringSchema.optional(),
    harnessPermissionMode: HarnessPermissionModeSchema.optional(),
  })
  .strict();

export type ConfigDefaults = z.infer<typeof ConfigDefaultsSchema>;

export const WorktreeWorktrunkConfigSchema = z
  .object({
    command: nonEmptyStringSchema.optional(),
    configPath: nonEmptyStringSchema.optional(),
    managedRoot: nonEmptyStringSchema.optional(),
    base: nonEmptyStringSchema.optional(),
    includeMain: z.boolean().optional(),
    includeExternal: z.boolean().optional(),
    useLifecycleHooks: z.boolean().optional(),
    hookMode: z.enum(["required-for-mvp", "disabled"]).optional(),
    breadcrumbLocation: z.enum(["external", "worktree", "provider-native", "disabled"]).optional(),
  })
  .strict();

export type WorktreeWorktrunkConfig = z.infer<typeof WorktreeWorktrunkConfigSchema>;

export const WorktreeProvidersConfigSchema = z
  .object({
    worktrunk: WorktreeWorktrunkConfigSchema.optional(),
  })
  .strict();

export type WorktreeProvidersConfig = z.infer<typeof WorktreeProvidersConfigSchema>;

export const TmuxConfigSchema = z
  .object({
    command: nonEmptyStringSchema.optional(),
    sessionPrefix: nonEmptyStringSchema.optional(),
    topology: z.enum(["workbench"]).optional(),
    workbenchSession: nonEmptyStringSchema.optional(),
    windowNaming: z.enum(["project-branch"]).optional(),
    primaryAgentPane: z.boolean().optional(),
    popupWidth: nonEmptyStringSchema.optional(),
    popupHeight: nonEmptyStringSchema.optional(),
    popupPosition: nonEmptyStringSchema.optional(),
  })
  .strict();

export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

export const TerminalProvidersConfigSchema = z
  .object({
    tmux: TmuxConfigSchema.optional(),
  })
  .strict();

export type TerminalProvidersConfig = z.infer<typeof TerminalProvidersConfigSchema>;

export const HarnessProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: nonEmptyStringSchema.optional(),
    profile: nonEmptyStringSchema.optional(),
    permissionMode: HarnessPermissionModeSchema.optional(),
    sandboxMode: nonEmptyStringSchema.optional(),
    approvalPolicy: nonEmptyStringSchema.optional(),
    installHooks: z.boolean().optional(),
    resume: z.boolean().optional(),
  })
  .strict();

export type HarnessProviderConfig = z.infer<typeof HarnessProviderConfigSchema>;

export const ClaudeHarnessPermissionModeSchema = z.union([
  HarnessPermissionModeSchema,
  z.literal("auto"),
]);

export type ClaudeHarnessPermissionMode = z.infer<typeof ClaudeHarnessPermissionModeSchema>;

export const ClaudeHarnessProviderConfigSchema = HarnessProviderConfigSchema.extend({
  permissionMode: ClaudeHarnessPermissionModeSchema.optional(),
});

export type ClaudeHarnessProviderConfig = z.infer<typeof ClaudeHarnessProviderConfigSchema>;

export const HarnessProvidersConfigSchema = z
  .object({
    claude: ClaudeHarnessProviderConfigSchema.optional(),
  })
  .catchall(HarnessProviderConfigSchema);

export type HarnessProvidersConfig = z.infer<typeof HarnessProvidersConfigSchema>;

export const HooksConfigSchema = z
  .object({
    event: z.array(ObserverEventHookConfigSchema).optional(),
  })
  .strict();

export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export const TuiTimeWidgetConfigSchema = z
  .object({
    type: z.literal("time"),
    timeFormat: z.enum(["12h", "24h"]).optional(),
  })
  .strict();

export type TuiTimeWidgetConfig = z.infer<typeof TuiTimeWidgetConfigSchema>;

export const TuiWeatherWidgetConfigSchema = z
  .object({
    type: z.literal("weather"),
    city: nonEmptyStringSchema,
    label: nonEmptyStringSchema.optional(),
    temperatureUnit: z.enum(["fahrenheit", "celsius"]).optional(),
    refreshIntervalMinutes: z.number().int().positive().optional(),
  })
  .strict();

export type TuiWeatherWidgetConfig = z.infer<typeof TuiWeatherWidgetConfigSchema>;

export const TuiWidgetConfigSchema = z.discriminatedUnion("type", [
  TuiTimeWidgetConfigSchema,
  TuiWeatherWidgetConfigSchema,
]);

export type TuiWidgetConfig = z.infer<typeof TuiWidgetConfigSchema>;

export const TuiConfigSchema = z
  .object({
    widgets: z.array(TuiWidgetConfigSchema).optional(),
  })
  .strict();

export type TuiConfig = z.infer<typeof TuiConfigSchema>;

export const GithubRepositoryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: nonEmptyStringSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type GithubRepositoryConfig = z.infer<typeof GithubRepositoryConfigSchema>;

export const RepositoryProvidersConfigSchema = z
  .object({
    github: GithubRepositoryConfigSchema.optional(),
  })
  .strict();

export type RepositoryProvidersConfig = z.infer<typeof RepositoryProvidersConfigSchema>;

export const ObservabilityRetentionComponentsSchema = z
  .object({
    observerMaxMb: z.number().int().positive().optional(),
    cliMaxMb: z.number().int().positive().optional(),
    tuiMaxMb: z.number().int().positive().optional(),
    hookRunnerMaxMb: z.number().int().positive().optional(),
    providerMaxMb: z.number().int().positive().optional(),
  })
  .strict();

export type ObservabilityRetentionComponents = z.infer<
  typeof ObservabilityRetentionComponentsSchema
>;

export const ObservabilityRetentionSqliteSchema = z
  .object({
    eventsMaxDays: z.number().int().positive().optional(),
    commandsMaxDays: z.number().int().positive().optional(),
    errorsMaxDays: z.number().int().positive().optional(),
    providerObservationsMaxDays: z.number().int().positive().optional(),
  })
  .strict();

export type ObservabilityRetentionSqlite = z.infer<typeof ObservabilityRetentionSqliteSchema>;

export const ObservabilityRetentionDebugBundlesSchema = z
  .object({
    maxBundles: z.number().int().positive().optional(),
    maxDays: z.number().int().positive().optional(),
  })
  .strict();

export type ObservabilityRetentionDebugBundles = z.infer<
  typeof ObservabilityRetentionDebugBundlesSchema
>;

export const ObservabilityRetentionHookSpoolSchema = z
  .object({
    deliveredDeleteImmediately: z.boolean().optional(),
    failedMaxDays: z.number().int().positive().optional(),
    failedMaxItems: z.number().int().positive().optional(),
  })
  .strict();

export type ObservabilityRetentionHookSpool = z.infer<typeof ObservabilityRetentionHookSpoolSchema>;

export const ObservabilityRetentionConfigSchema = z
  .object({
    maxDays: z.number().int().positive().optional(),
    maxTotalMb: z.number().int().positive().optional(),
    maxFileMb: z.number().int().positive().optional(),
    maxFilesPerComponent: z.number().int().positive().optional(),
    components: ObservabilityRetentionComponentsSchema.optional(),
    sqlite: ObservabilityRetentionSqliteSchema.optional(),
    debugBundles: ObservabilityRetentionDebugBundlesSchema.optional(),
    hookSpool: ObservabilityRetentionHookSpoolSchema.optional(),
  })
  .strict();

export type ObservabilityRetentionConfig = z.infer<typeof ObservabilityRetentionConfigSchema>;

export const ObservabilityConfigSchema = z
  .object({
    retention: ObservabilityRetentionConfigSchema.optional(),
  })
  .strict();

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

export const ProjectLocalConfigSchema = z
  .object({
    schemaVersion: ConfigSchemaVersionSchema,
    defaults: ProjectLocalDefaultsSchema.optional(),
    commands: z.record(nonEmptyStringSchema, nonEmptyStringSchema).optional(),
    display: ProjectDisplayConfigSchema.optional(),
  })
  .strict();

export type ProjectLocalConfig = z.infer<typeof ProjectLocalConfigSchema>;

export const ParsedStationConfigSchema = z
  .object({
    schemaVersion: ConfigSchemaVersionSchema,
    observer: ObserverConfigSchema.optional(),
    defaults: ConfigDefaultsSchema,
    worktree: WorktreeProvidersConfigSchema.optional(),
    terminal: TerminalProvidersConfigSchema.optional(),
    harness: HarnessProvidersConfigSchema.optional(),
    hooks: HooksConfigSchema.optional(),
    // TUI-only sections. Best-effort: bad values inside [tui]/[workspace]
    // degrade to defaults with a section diagnostic instead of aborting load.
    tui: TuiConfigSchema.optional().catch(undefined),
    workspace:
      WorkspaceConfigSchema.default(DEFAULT_WORKSPACE_CONFIG).catch(DEFAULT_WORKSPACE_CONFIG),
    repository: RepositoryProvidersConfigSchema.optional(),
    observability: ObservabilityConfigSchema.optional(),
    featureFlags: FeatureFlagConfigSchema.optional(),
    projects: z.array(ProjectConfigSchema),
  })
  .strict();

export const StationConfigSchema = ParsedStationConfigSchema;

export type ParsedStationConfig = z.infer<typeof ParsedStationConfigSchema>;
export type StationConfig = ParsedStationConfig;
