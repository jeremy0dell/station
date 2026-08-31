import type { ProviderId, SafeError, SessionGroupPlacementIntent } from "@station/contracts";
import { selectNewSessionHarnessOptions } from "../../selectors/harnessChoices.js";
import { selectNewSessionProject } from "../../selectors/projectChoices.js";
import type { NewSessionFlowStateView, NewSessionSnapshotView } from "./model.js";

export type NewSessionCreateValidation =
  | {
      ok: true;
      project: NonNullable<ReturnType<typeof selectNewSessionProject>>;
      title: string;
      branch: string;
      harnessProvider: ProviderId;
      group?: SessionGroupPlacementIntent;
    }
  | {
      ok: false;
      error: SafeError;
    };

export type NewSessionProjectResolution =
  | {
      kind: "available";
      project: NonNullable<ReturnType<typeof selectNewSessionProject>>;
    }
  | {
      kind: "blocked";
      error: SafeError;
    }
  | {
      kind: "missing";
    };

export function selectedProject(snapshot: NewSessionSnapshotView, state: NewSessionFlowStateView) {
  return selectNewSessionProject(snapshot, state.selectedProjectId);
}

export function validateNewSessionCreate(
  snapshot: NewSessionSnapshotView,
  state: NewSessionFlowStateView,
): NewSessionCreateValidation {
  const resolution = resolveNewSessionProjectAvailability(selectedProject(snapshot, state));
  if (resolution.kind === "missing") {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "PROJECT_NOT_CONFIGURED",
        message: "No project is configured for a new session.",
        hint: "Add a project to config.toml and run station reconcile.",
      },
    };
  }
  if (resolution.kind === "blocked") {
    return {
      ok: false,
      error: resolution.error,
    };
  }
  const project = resolution.project;

  const harness = selectNewSessionHarnessOptions(snapshot, project).find(
    (option) => option.id === state.selectedHarness,
  );
  if (harness?.status === "unavailable") {
    return {
      ok: false,
      error:
        harness.health?.lastError ??
        ({
          tag: "ProviderUnavailableError",
          code: "HARNESS_PROVIDER_UNAVAILABLE",
          message: `The harness provider ${harness.id} is unavailable.`,
          hint: "Run station doctor for provider diagnostics.",
          provider: harness.id,
        } satisfies SafeError),
    };
  }

  const title = state.title.trim();
  if (title.length === 0) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_TITLE_EMPTY",
        message: "Session name cannot be empty.",
      },
    };
  }

  const group = resolveGroupPlacement(snapshot, state);
  if (!group.ok) return group;

  return {
    ok: true,
    project,
    title,
    branch: state.branch,
    harnessProvider: state.selectedHarness,
    ...(group.placement === undefined ? {} : { group: group.placement }),
  };
}

export function resolveNewSessionProjectAvailability(
  project: ReturnType<typeof selectNewSessionProject>,
): NewSessionProjectResolution {
  if (project === undefined) {
    return { kind: "missing" };
  }
  if (project.health.status === "unavailable") {
    return {
      kind: "blocked",
      error:
        project.health.lastError ??
        ({
          tag: "ProviderUnavailableError",
          code: "WORKTREE_PROVIDER_UNAVAILABLE",
          message: "The worktree provider is unavailable.",
          hint: "Run station doctor for provider diagnostics.",
          provider: project.health.provider,
        } satisfies SafeError),
    };
  }
  return { kind: "available", project };
}

function resolveGroupPlacement(
  snapshot: NewSessionSnapshotView,
  state: NewSessionFlowStateView,
): { ok: true; placement?: SessionGroupPlacementIntent } | { ok: false; error: SafeError } {
  if (state.groupSelection.kind === "ungrouped") return { ok: true };
  if (state.groupSelection.kind === "create") {
    const name = state.groupSelection.name.trim();
    return name.length === 0
      ? {
          ok: false,
          error: {
            tag: "CommandValidationError",
            code: "SESSION_GROUP_NAME_EMPTY",
            message: "Group name cannot be empty.",
          },
        }
      : { ok: true, placement: { kind: "create", name } };
  }
  const selection = state.groupSelection;
  const group = snapshot.sessionGroups.find((candidate) => candidate.id === selection.groupId);
  if (group === undefined) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_GROUP_NOT_FOUND",
        message: "The selected Group no longer exists.",
      },
    };
  }
  if (group.projectId !== state.selectedProjectId) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_GROUP_PROJECT_MISMATCH",
        message: "The selected Group belongs to another project.",
      },
    };
  }
  if (group.parentGroupId !== undefined) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_GROUP_NOT_ROOT",
        message: "Nested Groups cannot receive a new session.",
      },
    };
  }
  return { ok: true, placement: selection };
}
