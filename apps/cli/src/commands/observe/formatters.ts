import type {
  ProviderHealth,
  SafeError,
  StationEvent,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import { stationEventTimestamp } from "@station/contracts";
import {
  commandTypeLabel,
  type ObserveSnapshotContext,
  rowLabel,
  sessionLabel,
  sessionWorktreeLabel,
  worktreeLabel,
} from "./snapshotContext.js";

export type ObserveSnapshotEnvelope = {
  kind: "snapshot";
  seq: number;
  receivedAt: string;
  snapshot: StationSnapshot;
};

export type ObserveEventEnvelope = {
  kind: "event";
  seq: number;
  receivedAt: string;
  event: StationEvent;
};

export type ObserveEnvelope = ObserveSnapshotEnvelope | ObserveEventEnvelope;

export function formatJsonEnvelope(envelope: ObserveEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function formatSnapshotLines(
  snapshot: StationSnapshot,
  _context: ObserveSnapshotContext,
  receivedAt: string,
): string[] {
  const at = snapshot.generatedAt ?? receivedAt;
  const lines = [
    line(
      at,
      "snapshot",
      `${snapshot.counts.projects} project  ${snapshot.counts.worktrees} worktree  ${snapshot.counts.agents} agent  working:${snapshot.counts.working} idle:${snapshot.counts.idle} attention:${snapshot.counts.attention}`,
    ),
  ];

  for (const row of snapshot.rows) {
    if (row.agent !== undefined) {
      lines.push(formatAgentRow(at, row));
    }
  }
  for (const orphan of snapshot.orphans ?? []) {
    lines.push(
      line(
        orphan.observedAt,
        "orphan!",
        `${orphan.kind} ${orphan.provider} ${orphan.id} ${orphan.reason}`,
      ),
    );
  }

  return lines;
}

export function formatEventLines(
  event: StationEvent,
  context: ObserveSnapshotContext,
  receivedAt: string,
): string[] {
  const at = stationEventTimestamp(event) ?? receivedAt;
  switch (event.type) {
    case "observer.started":
      return [line(at, "observer", "started")];
    case "observer.reconciled":
      return [
        line(at, "reconcile", joinParts([`changed:${event.changed}`, tracePart(event.traceId)])),
      ];
    case "project.updated": {
      const project = context.projects.get(event.projectId);
      return [line(at, "project", `updated ${project?.label ?? event.projectId}`)];
    }
    case "worktree.added":
      return [line(at, "worktree", `added ${rowLabel(event.row)}`)];
    case "worktree.updated":
      return [line(at, "worktree", `updated ${worktreeLabel(context, event.worktreeId)}`)];
    case "worktree.removed":
      return [line(at, "worktree", `removed ${worktreeLabel(context, event.worktreeId)}`)];
    case "worktree.agentStateChanged": {
      const row = context.rows.get(event.worktreeId);
      if (row !== undefined) {
        if (event.agent === undefined) {
          const { agent: _agent, ...rowWithoutAgent } = row;
          return [formatAgentRow(at, rowWithoutAgent)];
        }
        return [formatAgentRow(at, { ...row, agent: event.agent })];
      }
      if (event.agent !== undefined) {
        return [
          line(
            at,
            agentLineLabel(event.agent.state),
            `${event.worktreeId}  ${displayAgentState(event.agent.state)}  ${event.agent.harness} ${event.agent.confidence}`,
          ),
        ];
      }
      return [line(at, "agent", `${event.worktreeId}  none`)];
    }
    case "session.created":
      return [
        line(
          at,
          "session",
          joinParts([
            event.session.title,
            "created",
            statusPart(event.session.status.value),
            event.session.harness.provider,
            worktreeLabel(context, event.session.worktreeId),
          ]),
        ),
      ];
    case "session.updated": {
      const changedStatus =
        event.patch.status === undefined ? undefined : `status:${event.patch.status.value}`;
      return [
        line(
          at,
          "session",
          joinParts([
            sessionLabel(context, event.sessionId),
            "updated",
            changedStatus,
            sessionWorktreeLabel(context, event.sessionId),
          ]),
        ),
      ];
    }
    case "session.removed":
      return [line(at, "session", `${sessionLabel(context, event.sessionId)} removed`)];
    case "command.accepted":
      return [
        line(
          at,
          "command",
          joinParts(["accepted", event.command.type, event.commandId, tracePart(event.traceId)]),
        ),
      ];
    case "command.started":
      return [
        line(
          at,
          "command",
          joinParts(["started", event.command.type, event.commandId, tracePart(event.traceId)]),
        ),
      ];
    case "command.succeeded":
      return [
        line(
          at,
          "command",
          joinParts([
            "succeeded",
            commandTypeLabel(context, event.commandId),
            event.commandId,
            tracePart(event.traceId),
          ]),
        ),
      ];
    case "command.failed":
      return formatCommandFailedLines(at, event, context);
    case "provider.healthChanged":
      return [formatProviderHealthLine(at, event.provider, event.health)];
    case "providerHook.ingested":
      return [line(at, "ingress", `${event.provider} ${event.event} hook:${event.hookId}`)];
    case "harness.eventReported":
      return [line(at, "harness", `${event.provider} ${event.eventType} report:${event.reportId}`)];
    case "providerHook.spoolDrained":
      return [line(at, "spool", `drained:${event.drained} failed:${event.failed}`)];
  }
}

function formatAgentRow(at: string, row: WorktreeRow): string {
  const agent = row.agent;
  if (agent === undefined) {
    return line(at, "agent", `${rowLabel(row)}  none  ${terminalPart(row)}`);
  }
  return line(
    at,
    agentLineLabel(agent.state),
    joinParts([
      rowLabel(row),
      displayAgentState(agent.state),
      agent.harness,
      agent.confidence,
      row.worktree.dirty ? "dirty" : "clean",
      terminalPart(row),
    ]),
  );
}

function formatCommandFailedLines(
  at: string,
  event: Extract<StationEvent, { type: "command.failed" }>,
  context: ObserveSnapshotContext,
): string[] {
  const error = event.error;
  const parts = [
    "failed",
    commandTypeLabel(context, event.commandId),
    error.code,
    providerPart(error.provider),
    `cmd:${event.commandId}`,
    tracePart(event.traceId ?? error.traceId),
    diagnosticPart(error.diagnosticId),
  ];
  const lines = [line(at, "command!", joinParts(parts))];
  lines.push(indent(error.message));
  if (error.hint !== undefined) {
    lines.push(indent(`hint: ${error.hint}`));
  }
  return lines;
}

function formatProviderHealthLine(at: string, provider: string, health: ProviderHealth): string {
  const label = health.status === "healthy" ? "provider" : "provider!";
  return line(
    at,
    label,
    joinParts([
      provider,
      health.status,
      latencyPart(health.latencyMs),
      errorCodePart(health.lastError),
    ]),
  );
}

function line(at: string, label: string, text: string): string {
  return `${formatClockTime(at)}  ${label.padEnd(10)} ${text}`;
}

function indent(text: string): string {
  return `            ${text}`;
}

function formatClockTime(timestamp: string): string {
  const direct = /T(\d\d:\d\d:\d\d)/.exec(timestamp);
  if (direct !== null) {
    return direct[1] ?? timestamp;
  }
  const date = new Date(timestamp);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(11, 19);
  }
  return timestamp;
}

function agentLineLabel(state: string): string {
  return state === "needs_attention" || state === "stuck" ? "agent!" : "agent";
}

function displayAgentState(state: string): string {
  return state.replaceAll("_", " ");
}

function statusPart(status: string): string {
  return `status:${displayAgentState(status)}`;
}

function terminalPart(row: WorktreeRow): string {
  if (row.terminal === undefined) {
    return "terminal/none";
  }
  return `${row.terminal.provider}/${row.terminal.state}`;
}

function tracePart(traceId: string | undefined): string | undefined {
  return traceId === undefined ? undefined : `trace:${traceId}`;
}

function providerPart(provider: string | undefined): string | undefined {
  return provider === undefined ? undefined : `provider:${provider}`;
}

function diagnosticPart(diagnosticId: string | undefined): string | undefined {
  return diagnosticId === undefined ? undefined : `diag:${diagnosticId}`;
}

function latencyPart(latencyMs: number | undefined): string | undefined {
  return latencyMs === undefined ? undefined : `latency:${latencyMs}ms`;
}

function errorCodePart(error: SafeError | undefined): string | undefined {
  return error === undefined ? undefined : `error:${error.code}`;
}

function joinParts(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join("  ");
}
