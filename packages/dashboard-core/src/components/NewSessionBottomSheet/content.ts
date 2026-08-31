import type { ProviderHealth } from "@station/contracts";
import {
  type NewSessionActionId,
  newSessionActionEnabled,
} from "../../flows/newSession/actions.js";
import type {
  NewSessionEditGroupDraftStateView,
  NewSessionEditNameFocus,
  NewSessionEditNameStateView,
  NewSessionReviewFocus,
  NewSessionReviewStateView,
} from "../../flows/newSession/model.js";
import { selectNewSessionHarnessOptions } from "../../selectors/harnessChoices.js";
import { selectNewSessionProject } from "../../selectors/projectChoices.js";
import type { DashboardSnapshotView } from "../../state/types.js";

export type NewSessionReviewFieldId = "project" | "name" | "agent" | "group";

export type NewSessionStatusContent = {
  glyph: "●";
  text: ProviderHealth["status"];
  tone: ProviderHealth["status"];
};

export type NewSessionControlContent<TFocus extends string = string> = {
  actionId: NewSessionActionId;
  label: string;
  accelerator: string | undefined;
  enabled: boolean;
  focusId: TFocus;
  helper: string;
};

export type NewSessionReviewFieldContent = NewSessionControlContent<NewSessionReviewFieldId> & {
  id: NewSessionReviewFieldId;
  value: string;
  status?: NewSessionStatusContent;
};

/** Pure review copy whose controls carry the action, focus, availability, and helper metadata. */
export type NewSessionReviewContent = {
  fields: readonly NewSessionReviewFieldContent[];
  create: NewSessionControlContent<"create">;
  helper: string;
};

export type NewSessionEditNameContent = {
  controls: Readonly<
    Record<NewSessionEditNameFocus, NewSessionControlContent<NewSessionEditNameFocus>>
  >;
  helper: string;
};

export type NewSessionEditGroupDraftContent = {
  controls: Readonly<Record<"save" | "back", NewSessionControlContent<"save" | "back">>>;
  helper: string;
};

const REVIEW_CONTROLS: {
  readonly [TFocus in NewSessionReviewFocus]: Omit<NewSessionControlContent<TFocus>, "enabled">;
} = {
  project: {
    actionId: "review.project",
    label: "Project",
    accelerator: "P",
    focusId: "project",
    helper: "Enter choose project",
  },
  name: {
    actionId: "review.name",
    label: "Name",
    accelerator: "N",
    focusId: "name",
    helper: "Enter edit name",
  },
  agent: {
    actionId: "review.agent",
    label: "Agent",
    accelerator: "A",
    focusId: "agent",
    helper: "Enter choose agent",
  },
  group: {
    actionId: "review.group",
    label: "Group",
    accelerator: "G",
    focusId: "group",
    helper: "Enter choose Group",
  },
  create: {
    actionId: "review.create",
    label: "Create session",
    accelerator: "C",
    focusId: "create",
    helper: "Enter create session",
  },
};

const EDIT_NAME_CONTROLS: {
  readonly [TFocus in NewSessionEditNameFocus]: NewSessionControlContent<TFocus>;
} = {
  name: {
    actionId: "editName.name",
    label: "Name",
    accelerator: undefined,
    enabled: true,
    focusId: "name",
    helper: "Type name · Left/Right cursor · ↓ actions · Enter save",
  },
  save: {
    actionId: "editName.save",
    label: "Save",
    accelerator: "Ctrl-S",
    enabled: true,
    focusId: "save",
    helper: "←→ action · ↑ name · Enter save · Esc back",
  },
  back: {
    actionId: "editName.back",
    label: "Back",
    accelerator: "Esc",
    enabled: true,
    focusId: "back",
    helper: "←→ action · ↑ name · Enter back without saving",
  },
};

const EDIT_GROUP_DRAFT_CONTROLS = {
  save: {
    actionId: "editGroupDraft.save",
    label: "Save",
    accelerator: "Enter",
    focusId: "save",
    helper: "Type Group name · Enter save · Esc discard",
  },
  back: {
    actionId: "editGroupDraft.back",
    label: "Back",
    accelerator: "Esc",
    focusId: "back",
    helper: "Type Group name · Enter save · Esc discard",
  },
} as const;

function newSessionGroupValue(
  snapshot: DashboardSnapshotView,
  state: NewSessionReviewStateView,
): string {
  const selection = state.groupSelection;
  switch (selection.kind) {
    case "ungrouped":
      return "Ungrouped";
    case "create":
      return `Create “${selection.name}”`;
    case "existing":
      return (
        snapshot.sessionGroups.find(
          (group) =>
            group.id === selection.groupId &&
            group.projectId === state.selectedProjectId &&
            group.parentGroupId === undefined,
        )?.name ?? "Ungrouped"
      );
  }
}

/** Builds the renderer-neutral Create Session review model from typed snapshot state. */
export function newSessionReviewContent(
  snapshot: DashboardSnapshotView,
  state: NewSessionReviewStateView,
): NewSessionReviewContent {
  const project = selectNewSessionProject(snapshot, state.selectedProjectId);
  const harness =
    project === undefined
      ? undefined
      : selectNewSessionHarnessOptions(snapshot, project).find(
          (option) => option.id === state.selectedHarness,
        );
  const status = harness?.status ?? "unknown";
  const groupValue = newSessionGroupValue(snapshot, state);
  const fields: NewSessionReviewFieldContent[] = [
    { ...REVIEW_CONTROLS.project, enabled: true, id: "project", value: project?.label ?? "-" },
    { ...REVIEW_CONTROLS.name, enabled: true, id: "name", value: state.title },
    {
      ...REVIEW_CONTROLS.agent,
      enabled: true,
      id: "agent",
      value: harness?.label ?? state.selectedHarness,
      status: { glyph: "●", text: status, tone: status },
    },
    { ...REVIEW_CONTROLS.group, enabled: true, id: "group", value: groupValue },
  ];
  return {
    fields,
    create: {
      ...REVIEW_CONTROLS.create,
      enabled: newSessionActionEnabled(snapshot, state, "review.create"),
      label: state.submissionLocalId === undefined ? REVIEW_CONTROLS.create.label : "Creating…",
    },
    helper:
      state.submissionLocalId === undefined
        ? REVIEW_CONTROLS[state.reviewFocus].helper
        : "Creating session…",
  };
}

export function newSessionEditNameContent(
  state: NewSessionEditNameStateView,
): NewSessionEditNameContent {
  return {
    controls: EDIT_NAME_CONTROLS,
    helper: EDIT_NAME_CONTROLS[state.editNameFocus].helper,
  };
}

export function newSessionEditGroupDraftContent(
  state: NewSessionEditGroupDraftStateView,
): NewSessionEditGroupDraftContent {
  return {
    controls: {
      save: {
        ...EDIT_GROUP_DRAFT_CONTROLS.save,
        enabled: newSessionActionEnabled(undefined, state, "editGroupDraft.save"),
      },
      back: { ...EDIT_GROUP_DRAFT_CONTROLS.back, enabled: true },
    },
    helper: EDIT_GROUP_DRAFT_CONTROLS.save.helper,
  };
}
