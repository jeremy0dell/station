import {
  ObserverEventHookInvocationSchema,
  type StationEvent,
  type WorktreeRow,
} from "@station/contracts";
import type { ExternalCommandRunner } from "@station/runtime";
import {
  buildClickFocusShellCommand,
  buildFocusCommand,
  defaultCliCommandParts,
} from "./notify/focusAction.js";
import { playMacNotificationSound, showMacNotification } from "./notify/macos.js";

export type NotifyCommandOptions = {
  stdin?: string;
  platform?: NodeJS.Platform;
  configPath?: string;
};

export type NotifyCommandDeps = {
  commandRunner?: ExternalCommandRunner;
  cliCommandParts?: string[];
  platform?: NodeJS.Platform;
};

export type NotifyCommandResult = {
  notified: boolean;
  skipped?: boolean;
  reason?: string;
  title?: string;
  message?: string;
  notifier?: "terminal-notifier" | "osascript";
  sound?: "played" | "failed" | "skipped";
  clickAction?: boolean;
};

type WorktreeAgent = NonNullable<WorktreeRow["agent"]>;
type WorktreeAgentStateChangedEvent = Extract<StationEvent, { type: "worktree.agentStateChanged" }>;
type NotificationKind = "finished";

type NotifiableAgentEvent = {
  event: WorktreeAgentStateChangedEvent;
  agent: WorktreeAgent;
  kind: NotificationKind;
};

const notifyKind = "agent-state";

function notificationMessage(agent: WorktreeAgent): string {
  const harness = agent.harness;
  return agent.reason === undefined ? `${harness} is idle.` : agent.reason;
}

function notificationIdentity(event: WorktreeAgentStateChangedEvent, agent: WorktreeAgent): string {
  return agent.sessionId ?? event.worktreeId;
}

function notificationTitle(input: NotifiableAgentEvent): string {
  if (input.event.sessionTitle !== undefined) {
    return input.event.sessionTitle;
  }
  const identity = notificationIdentity(input.event, input.agent);
  return `${identity} finished`;
}

function notifiableAgentEvent(
  event: WorktreeAgentStateChangedEvent,
): NotifiableAgentEvent | undefined {
  const agent = event.agent;
  if (agent === undefined) {
    return undefined;
  }
  if (agent.state === "idle") {
    return { event, agent, kind: "finished" };
  }
  return undefined;
}

export async function runNotifyCommand(
  args: string[],
  options: NotifyCommandOptions = {},
  deps: NotifyCommandDeps = {},
): Promise<NotifyCommandResult> {
  const [kind] = args;
  if (kind !== notifyKind) {
    throw new Error("Usage: station notify agent-state");
  }
  const source = options.stdin?.trim();
  if (source === undefined || source.length === 0) {
    throw new Error("stn notify agent-state requires an event hook invocation on stdin.");
  }
  const invocation = ObserverEventHookInvocationSchema.parse(JSON.parse(source));
  if (invocation.event.type !== "worktree.agentStateChanged") {
    return { notified: false, skipped: true, reason: "unsupported-event" };
  }
  if (invocation.event.changeSource === "reconcile") {
    return { notified: false, skipped: true, reason: "non-hook-agent-state-change" };
  }
  const notifiable = notifiableAgentEvent(invocation.event);
  if (notifiable === undefined) {
    return { notified: false, skipped: true, reason: "agent-not-notifiable" };
  }
  const title = notificationTitle(notifiable);
  const message = notificationMessage(notifiable.agent);
  const platform = deps.platform ?? options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { notified: false, skipped: true, reason: "unsupported-platform", title, message };
  }

  const focusCommand = buildFocusCommand(notifiable.event);
  const clickActionInput: Parameters<typeof buildClickFocusShellCommand>[0] = {
    command: focusCommand,
    cliCommandParts: deps.cliCommandParts ?? defaultCliCommandParts(),
  };
  if (options.configPath !== undefined) {
    clickActionInput.configPath = options.configPath;
  }
  const clickAction = buildClickFocusShellCommand(clickActionInput);
  const group = `station:${notificationIdentity(notifiable.event, notifiable.agent)}`;
  const soundInput: Parameters<typeof playMacNotificationSound>[0] = {
    kind: notifiable.kind,
  };
  if (deps.commandRunner !== undefined) {
    soundInput.commandRunner = deps.commandRunner;
  }
  const soundPromise = playMacNotificationSound(soundInput);
  const notifier = await showMacNotification(
    {
      title,
      message,
      group,
      clickAction,
    },
    deps.commandRunner,
  );
  const sound = await soundPromise;
  return {
    notified: true,
    title,
    message,
    notifier,
    sound,
    clickAction: notifier === "terminal-notifier",
  };
}
