import type {
  TerminalIdentityBinding,
  TerminalTargetObservation,
  WorktreeObservation,
} from "./observations.js";

export function terminalTargetObservationFromBinding(input: {
  binding: TerminalIdentityBinding;
  worktree: WorktreeObservation;
  observedAt: string;
}): TerminalTargetObservation {
  const target: TerminalTargetObservation = {
    id: input.binding.targetId,
    provider: input.binding.provider,
    state: "open",
    confidence: input.binding.confidence,
    reason: input.binding.reason,
    observedAt: input.observedAt,
  };
  if (input.binding.projectId !== undefined) target.projectId = input.binding.projectId;
  if (input.binding.worktreeId !== undefined) target.worktreeId = input.binding.worktreeId;
  if (input.binding.sessionId !== undefined) target.sessionId = input.binding.sessionId;
  if (input.binding.harnessRunId !== undefined) target.harnessRunId = input.binding.harnessRunId;
  if (input.worktree.path.length > 0) target.cwd = input.worktree.path;
  if (input.binding.harnessBinding !== undefined) {
    target.harnessBinding = input.binding.harnessBinding;
  }
  if (input.binding.providerData !== undefined) target.providerData = input.binding.providerData;
  return target;
}
