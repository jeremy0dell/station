import type { TerminalTargetObservation } from "@station/contracts";
import { z } from "zod";
import { buildTmuxTargetId } from "./targetId.js";

const stableSessionIdSchema = z.string().regex(/^\$\d+$/u);
const stableWindowIdSchema = z.string().regex(/^@\d+$/u);
const stablePaneIdSchema = z.string().regex(/^%\d+$/u);
const positiveIntegerTextSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform((value) => Number(value));
const nonNegativeIntegerTextSchema = z
  .string()
  .regex(/^\d+$/u)
  .transform((value) => Number(value));

const TmuxPaneProofSchema = z
  .object({
    socketPath: z.string().min(1),
    serverPid: positiveIntegerTextSchema,
    sessionId: stableSessionIdSchema,
    sessionName: z.string().min(1),
    windowId: stableWindowIdSchema,
    paneId: stablePaneIdSchema,
    panePid: positiveIntegerTextSchema,
    openToken: z.string(),
    stationSessionId: z.string(),
  })
  .strict();

export type TmuxPaneProof = z.infer<typeof TmuxPaneProofSchema>;

export const tmuxPaneProofFormat = [
  "#{socket_path}",
  "#{pid}",
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{@station.open_token}",
  "#{@station.session_id}",
].join("\t");

export const tmuxPrimaryPaneIdentityFormat = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{pane_id}",
].join("\t");

const TmuxClientIdentitySchema = z
  .object({
    clientName: z.string().min(1),
    clientPid: positiveIntegerTextSchema,
  })
  .strict();

const TmuxClientSelectionSchema = TmuxClientIdentitySchema.extend({
  sessionId: stableSessionIdSchema,
  windowId: stableWindowIdSchema,
  paneId: stablePaneIdSchema,
}).strict();

export type TmuxClientIdentity = z.infer<typeof TmuxClientIdentitySchema>;
export type TmuxClientSelection = z.infer<typeof TmuxClientSelectionSchema>;

export const tmuxClientIdentityFormat = ["#{client_name}", "#{client_pid}"].join("\t");

export const tmuxClientSelectionFormat = [
  "#{client_name}",
  "#{client_pid}",
  "#{session_id}",
  "#{window_id}",
  "#{pane_id}",
].join("\t");

export function parseTmuxPaneProof(stdout: string): TmuxPaneProof {
  const proofs = parseTmuxPaneProofLines(stdout);
  if (proofs.length !== 1) throw new Error("tmux returned ambiguous pane proof.");
  const proof = proofs[0];
  if (proof === undefined) throw new Error("tmux returned no pane proof.");
  return proof;
}

export function parseTmuxPaneProofLines(stdout: string): TmuxPaneProof[] {
  if (stdout.trim().length === 0) return [];
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 9) throw new Error("tmux returned malformed pane proof.");
      return TmuxPaneProofSchema.parse({
        socketPath: fields[0],
        serverPid: fields[1],
        sessionId: fields[2],
        sessionName: fields[3],
        windowId: fields[4],
        paneId: fields[5],
        panePid: fields[6],
        openToken: fields[7],
        stationSessionId: fields[8],
      });
    });
}

export function parseTmuxClientSelections(stdout: string): TmuxClientSelection[] {
  if (stdout.trim().length === 0) return [];
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 5) throw new Error("tmux returned malformed client selection.");
      return TmuxClientSelectionSchema.parse({
        clientName: fields[0],
        clientPid: fields[1],
        sessionId: fields[2],
        windowId: fields[3],
        paneId: fields[4],
      });
    });
}

export function parseTmuxClientIdentities(stdout: string): TmuxClientIdentity[] {
  if (stdout.trim().length === 0) return [];
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 2) throw new Error("tmux returned malformed client identity.");
      return TmuxClientIdentitySchema.parse({ clientName: fields[0], clientPid: fields[1] });
    });
}

export function parseTmuxPrimaryPaneIdentity(stdout: string): {
  sessionId: string;
  sessionName: string;
  windowId: string;
  paneId: string;
} {
  const fields = stdout.trim().split("\t");
  if (fields.length !== 4) throw new Error("tmux returned malformed primary pane identity.");
  const result = z
    .object({
      sessionId: stableSessionIdSchema,
      sessionName: z.string().min(1),
      windowId: stableWindowIdSchema,
      paneId: stablePaneIdSchema,
    })
    .strict()
    .parse({
      sessionId: fields[0],
      sessionName: fields[1],
      windowId: fields[2],
      paneId: fields[3],
    });
  return result;
}

export const tmuxListTargetsFormat = [
  "#{session_name}",
  "#{session_id}",
  "#{window_id}",
  "#{pane_id}",
  "#{session_attached}",
  "#{pane_dead}",
  "#{pane_dead_status}",
  "#{pane_current_path}",
  "#{pane_pid}",
  "#{pane_current_command}",
  "#{window_name}",
  "#{@station.session_id}",
  "#{@station.project_id}",
  "#{@station.worktree_id}",
  "#{@station.worktree_path}",
  "#{@station.role}",
  "#{@station.harness}",
].join("\t");

const TmuxTargetRowSchema = z
  .object({
    sessionName: z.string().min(1),
    sessionId: stableSessionIdSchema,
    windowId: stableWindowIdSchema,
    paneId: stablePaneIdSchema,
    attachedClients: nonNegativeIntegerTextSchema,
    paneDead: z.enum(["0", "1"]).transform((value) => value === "1"),
    paneDeadStatus: z.string(),
    cwd: z.string(),
    pid: z.union([z.literal(""), positiveIntegerTextSchema]),
    currentCommand: z.string(),
    title: z.string(),
    stationSessionId: z.string(),
    projectId: z.string(),
    worktreeId: z.string(),
    worktreePath: z.string(),
    role: z.string(),
    harness: z.string(),
  })
  .strict();

export type TmuxTargetRow = z.infer<typeof TmuxTargetRowSchema>;

export function parseTmuxTargetRows(stdout: string): TmuxTargetRow[] {
  if (stdout.trim().length === 0) return [];
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 17) throw new Error("tmux returned a malformed target row.");
      return TmuxTargetRowSchema.parse({
        sessionName: fields[0],
        sessionId: fields[1],
        windowId: fields[2],
        paneId: fields[3],
        attachedClients: fields[4],
        paneDead: fields[5],
        paneDeadStatus: fields[6],
        cwd: fields[7],
        pid: fields[8],
        currentCommand: fields[9],
        title: fields[10],
        stationSessionId: fields[11],
        projectId: fields[12],
        worktreeId: fields[13],
        worktreePath: fields[14],
        role: fields[15],
        harness: fields[16],
      });
    });
}

export function parseTmuxTargetLines(
  stdout: string,
  options: {
    observedAt: string;
    generation: string;
  },
): TerminalTargetObservation[] {
  return tmuxTargetObservations(parseTmuxTargetRows(stdout), options);
}

export function tmuxTargetObservations(
  rows: readonly TmuxTargetRow[],
  options: {
    observedAt: string;
    generation: string;
  },
): TerminalTargetObservation[] {
  return rows.map((row) => tmuxTargetObservation(row, options));
}

function tmuxTargetObservation(
  row: TmuxTargetRow,
  options: { observedAt: string; generation: string },
): TerminalTargetObservation {
  const hasBinding =
    row.projectId.length > 0 &&
    row.worktreeId.length > 0 &&
    row.role === "main-agent" &&
    row.harness.length > 0;
  const providerData: Record<string, unknown> = {
    sessionName: row.sessionName,
    windowId: row.windowId,
    paneId: row.paneId,
    paneTarget: row.paneId,
    attached: row.attachedClients > 0,
    dead: row.paneDead,
  };
  if (row.title.length > 0) {
    providerData.windowName = row.title;
  }
  if (row.paneDeadStatus.length > 0) {
    providerData.deadStatus = row.paneDeadStatus;
  }
  const target: TerminalTargetObservation = {
    id: buildTmuxTargetId({
      generation: options.generation,
      sessionId: row.sessionId,
      windowId: row.windowId,
      paneId: row.paneId,
    }),
    provider: "tmux",
    ...(row.projectId.length === 0 ? {} : { projectId: row.projectId }),
    ...(row.worktreeId.length === 0 ? {} : { worktreeId: row.worktreeId }),
    ...(row.stationSessionId.length === 0 ? {} : { sessionId: row.stationSessionId }),
    state: row.paneDead ? "stale" : row.attachedClients > 0 ? "open" : "detached",
    ...(row.cwd.length === 0 ? {} : { cwd: row.cwd }),
    ...(row.pid === "" ? {} : { pid: row.pid }),
    ...(row.title.length === 0 ? {} : { title: row.title }),
    confidence: hasBinding ? "high" : "low",
    reason: targetReason({ hasBinding, isDead: row.paneDead }),
    observedAt: options.observedAt,
    providerData,
  };
  if (hasBinding) {
    target.harnessBinding = {
      role: row.role,
      harnessProvider: row.harness,
    };
    if (row.worktreePath.length > 0) {
      target.harnessBinding.worktreePath = row.worktreePath;
    }
    if (row.currentCommand.length > 0) {
      target.harnessBinding.currentCommand = row.currentCommand;
    }
  }
  return target;
}

function targetReason(input: { hasBinding: boolean; isDead: boolean }): string {
  if (input.isDead && input.hasBinding) {
    return "tmux pane has station identity binding but is dead.";
  }
  if (input.isDead) {
    return "tmux pane is dead and missing station identity binding.";
  }
  return input.hasBinding
    ? "tmux pane has station identity binding."
    : "tmux pane is missing station identity binding.";
}
