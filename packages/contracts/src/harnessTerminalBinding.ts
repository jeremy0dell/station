import { normalize as normalizePath } from "node:path";
import { z } from "zod";
import { ProviderIdSchema } from "./ids.js";
import type {
  HarnessRunObservation,
  TerminalTargetObservation,
  WorktreeObservation,
} from "./observations.js";
import type { HarnessDiscoveryContext } from "./providers.js";

const nonEmptyStringSchema = z.string().min(1);

export const TerminalHarnessBindingSchema = z
  .object({
    role: nonEmptyStringSchema,
    harnessProvider: ProviderIdSchema,
    worktreePath: nonEmptyStringSchema.optional(),
    currentCommand: nonEmptyStringSchema.optional(),
  })
  .strict();

export type TerminalHarnessBinding = z.infer<typeof TerminalHarnessBindingSchema>;

export function terminalTargetMatchesHarnessBinding(input: {
  target: TerminalTargetObservation;
  harnessProvider: string;
  role?: string | undefined;
}): TerminalHarnessBinding | undefined {
  const binding = input.target.harnessBinding;
  if (binding === undefined || binding.harnessProvider !== input.harnessProvider) {
    return undefined;
  }
  if (input.role !== undefined && binding.role !== input.role) {
    return undefined;
  }
  return binding;
}

export function terminalTargetMatchesKnownWorktree(
  target: TerminalTargetObservation,
  worktrees: readonly WorktreeObservation[],
): boolean {
  if (target.worktreeId === undefined) {
    return true;
  }
  const worktree = worktrees.find((candidate) => candidate.id === target.worktreeId);
  if (worktree === undefined) {
    return true;
  }
  if (
    target.harnessBinding?.worktreePath !== undefined &&
    !sameObservedPath(target.harnessBinding.worktreePath, worktree.path)
  ) {
    return false;
  }
  if (target.cwd === undefined) {
    return true;
  }
  return observedPathIsSameOrInside(target.cwd, worktree.path);
}

export function isDefinitelyShellCommand(command: string | undefined): boolean {
  if (command === undefined) {
    return false;
  }
  return new Set(["bash", "dash", "fish", "sh", "tmux", "zsh"]).has(command);
}

export function harnessRunIdForTerminalTarget(
  harnessProvider: string,
  terminalTargetId: string,
): string {
  return `${harnessProvider}:${terminalTargetId}`;
}

export function terminalHarnessRunProviderData(
  terminalProvider: string,
  terminalTargetId: string,
  command: string | undefined,
): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    terminalProvider,
    terminalTargetId,
  };
  if (command !== undefined) {
    providerData.process = {
      command,
    };
  }
  return providerData;
}

export function terminalBoundHarnessRunObservation(input: {
  harnessProvider: string;
  target: TerminalTargetObservation;
  currentCommand: string | undefined;
  reason: string;
}): HarnessRunObservation {
  const run: HarnessRunObservation = {
    id:
      input.target.harnessRunId ??
      harnessRunIdForTerminalTarget(input.harnessProvider, input.target.id),
    provider: input.harnessProvider,
    state: "unknown",
    confidence: "low",
    reason: input.reason,
    observedAt: input.target.observedAt,
    providerData: terminalHarnessRunProviderData(
      input.target.provider,
      input.target.id,
      input.currentCommand,
    ),
  };
  if (input.target.projectId !== undefined) {
    run.projectId = input.target.projectId;
  }
  if (input.target.worktreeId !== undefined) {
    run.worktreeId = input.target.worktreeId;
  }
  if (input.target.sessionId !== undefined) {
    run.sessionId = input.target.sessionId;
  }
  if (input.target.pid !== undefined) {
    run.pid = input.target.pid;
  }
  if (input.target.cwd !== undefined) {
    run.cwd = input.target.cwd;
  }
  return run;
}

export function discoverTerminalBoundHarnessRuns(
  context: HarnessDiscoveryContext,
  options: {
    harnessProvider: string;
    displayName: string;
    role?: string | undefined;
  },
): HarnessRunObservation[] {
  const runs: HarnessRunObservation[] = [];
  for (const target of context.terminalTargets) {
    const binding = terminalTargetMatchesHarnessBinding({
      target,
      harnessProvider: options.harnessProvider,
      role: options.role,
    });
    if (binding === undefined) {
      continue;
    }
    if (isDefinitelyShellCommand(binding.currentCommand)) {
      continue;
    }
    if (!terminalTargetMatchesKnownWorktree(target, context.worktrees)) {
      continue;
    }

    runs.push(
      terminalBoundHarnessRunObservation({
        harnessProvider: options.harnessProvider,
        target,
        currentCommand: binding.currentCommand,
        reason: `terminal target is bound to ${options.displayName}; no reliable lifecycle signal yet.`,
      }),
    );
  }
  return runs;
}

export function observedPathIsSameOrInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeObservedPath(candidate);
  const normalizedRoot = normalizeObservedPath(root);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  if (normalizedRoot === "/") {
    return normalizedCandidate.startsWith("/");
  }
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function sameObservedPath(left: string, right: string): boolean {
  return normalizeObservedPath(left) === normalizeObservedPath(right);
}

export function normalizeObservedPath(value: string): string {
  const normalized = normalizePath(value.trim());
  const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/g, "") : normalized;
  return withoutTrailingSlash.startsWith("/private/var/")
    ? `/var/${withoutTrailingSlash.slice("/private/var/".length)}`
    : withoutTrailingSlash;
}
