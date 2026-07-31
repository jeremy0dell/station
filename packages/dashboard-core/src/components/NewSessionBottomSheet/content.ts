import type { ProviderHealth, StationSnapshot } from "@station/contracts";
import {
  type NewSessionActionId,
  type NewSessionEditNameFocus,
  type NewSessionEditNameState,
  type NewSessionReviewFocus,
  type NewSessionReviewState,
  newSessionActionEnabled,
} from "../../flows/newSession.js";
import {
  selectNewSessionHarnessOptions,
  selectNewSessionProject,
} from "../../selectors/selectors.js";

export type NewSessionReviewFieldId = "project" | "name" | "agent";

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

/** Builds the renderer-neutral Create Session review model from typed snapshot state. */
export function newSessionReviewContent(
  snapshot: StationSnapshot,
  state: NewSessionReviewState,
): NewSessionReviewContent {
  const project = selectNewSessionProject(snapshot, state.selectedProjectId);
  const harness =
    project === undefined
      ? undefined
      : selectNewSessionHarnessOptions(snapshot, project).find(
          (option) => option.id === state.selectedHarness,
        );
  const status = harness?.status ?? "unknown";
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
  ];
  return {
    fields,
    create: {
      ...REVIEW_CONTROLS.create,
      enabled: newSessionActionEnabled(snapshot, state, "review.create"),
    },
    helper: REVIEW_CONTROLS[state.reviewFocus].helper,
  };
}

export function newSessionEditNameContent(
  state: NewSessionEditNameState,
): NewSessionEditNameContent {
  return {
    controls: EDIT_NAME_CONTROLS,
    helper: EDIT_NAME_CONTROLS[state.editNameFocus].helper,
  };
}
