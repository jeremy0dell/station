import { z } from "zod";
import { SafeErrorSchema } from "./errors.js";
import { TimestampSchema } from "./ids.js";
import { LogComponentSchema } from "./logging.js";
import { nonEmptyStringSchema } from "./shared.js";

export const UiRunIdSchema = z
  .string()
  .regex(/^ui_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export type UiRunId = z.infer<typeof UiRunIdSchema>;

export const UiLifecycleSourceIdSchema = nonEmptyStringSchema;
export const UiLifecycleEventIdSchema = nonEmptyStringSchema;
export const UiLifecycleComponentSchema = LogComponentSchema.extract([
  "cli",
  "tui",
  "station-host",
]);
export type UiLifecycleComponent = z.infer<typeof UiLifecycleComponentSchema>;

export const UiLifecycleClientKindSchema = z.enum([
  "native_renderer",
  "dashboard_renderer",
  "observer",
  "host_tool",
  "test",
]);
export type UiLifecycleClientKind = z.infer<typeof UiLifecycleClientKindSchema>;

export const UiRunContextSchema = z
  .object({
    uiRunId: UiRunIdSchema,
    rendererPid: z.number().int().positive(),
    clientKind: UiLifecycleClientKindSchema,
  })
  .strict();
export type UiRunContext = z.infer<typeof UiRunContextSchema>;

export const UiRendererEntrySchema = z.enum(["station", "dashboard"]);
export type UiRendererEntry = z.infer<typeof UiRendererEntrySchema>;

export const UiLifecycleSurfaceSchema = z.enum([
  "welcome",
  "workspace",
  "station_overlay",
  "context_menu",
]);
export type UiLifecycleSurface = z.infer<typeof UiLifecycleSurfaceSchema>;

export const UiSurfaceChangeReasonSchema = z.enum([
  "overlay_open",
  "overlay_close",
  "state_change",
]);
export type UiSurfaceChangeReason = z.infer<typeof UiSurfaceChangeReasonSchema>;

export const UiShutdownReasonSchema = z.enum(["ctrl_q", "tty_takeover", "fatal"]);
export type UiShutdownReason = z.infer<typeof UiShutdownReasonSchema>;

export const UiLifecycleDetachReasonSchema = z.enum([
  "explicit_detach",
  "client_shutdown",
  "socket_closed",
  "attachment_replaced",
  "stream_failed",
  "pty_exited",
]);
export type UiLifecycleDetachReason = z.infer<typeof UiLifecycleDetachReasonSchema>;

export const UiRendererSignalSchema = z.enum([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGIOT",
  "SIGKILL",
  "SIGPOLL",
  "SIGPWR",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGSYS",
  "SIGUNUSED",
  "SIGBREAK",
  "SIGLOST",
  "SIGINFO",
]);
export type UiRendererSignal = z.infer<typeof UiRendererSignalSchema>;

const UiLifecycleEventBaseSchema = z.object({
  timestamp: TimestampSchema,
  component: UiLifecycleComponentSchema,
  eventId: UiLifecycleEventIdSchema,
  kind: nonEmptyStringSchema,
  uiRunId: UiRunIdSchema,
  source: z
    .object({
      id: UiLifecycleSourceIdSchema,
      sequence: z.number().int().nonnegative(),
      pid: z.number().int().positive(),
    })
    .strict(),
});

export const UiLifecycleEventSchema = z.discriminatedUnion("kind", [
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("cli"),
    kind: z.literal("renderer.spawned"),
    rendererPid: z.number().int().positive(),
    entry: UiRendererEntrySchema,
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("cli"),
    kind: z.literal("renderer.spawn_failed"),
    entry: UiRendererEntrySchema,
    error: SafeErrorSchema,
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("cli"),
    kind: z.literal("renderer.exited"),
    rendererPid: z.number().int().positive(),
    exitCode: z.number().int().nullable(),
    signal: UiRendererSignalSchema.nullable(),
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("tui"),
    kind: z.literal("ui.started"),
    rendererPid: z.number().int().positive(),
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("tui"),
    kind: z.literal("ui.ready"),
    rendererPid: z.number().int().positive(),
    surface: UiLifecycleSurfaceSchema,
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("tui"),
    kind: z.literal("ui.surface.changed"),
    before: UiLifecycleSurfaceSchema,
    after: UiLifecycleSurfaceSchema,
    reason: UiSurfaceChangeReasonSchema,
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("tui"),
    kind: z.literal("ui.shutdown.requested"),
    reason: UiShutdownReasonSchema,
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("tui"),
    kind: z.literal("ui.fatal"),
    error: SafeErrorSchema,
  }).strict(),
  UiLifecycleEventBaseSchema.extend({
    component: z.literal("tui"),
    kind: z.literal("ui.shutdown.completed"),
    reason: UiShutdownReasonSchema,
  }).strict(),
]);

export type UiLifecycleEvent = z.infer<typeof UiLifecycleEventSchema>;

type UiLifecycleGeneratedField = "timestamp" | "component" | "eventId" | "source";

export type UiLifecycleEventInputFor<Component extends UiLifecycleComponent> =
  UiLifecycleEvent extends infer Event
    ? Event extends UiLifecycleEvent
      ? Event["component"] extends Component
        ? Omit<Event, UiLifecycleGeneratedField>
        : never
      : never
    : never;

export type UiLifecycleEventInput = UiLifecycleEventInputFor<UiLifecycleComponent>;
