import type { ProviderHealth, StationSnapshot } from "@station/contracts";
import {
  type NewSessionReviewFocus,
  type NewSessionReviewState,
  validateNewSessionCreate,
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

export type NewSessionReviewFieldContent = {
  id: NewSessionReviewFieldId;
  label: string;
  value: string;
  status?: NewSessionStatusContent;
};

/** Pure review copy whose labels, status text, and helper stay aligned with activation semantics. */
export type NewSessionReviewContent = {
  fields: readonly NewSessionReviewFieldContent[];
  create: { label: string; shortcut: "C"; disabled: boolean };
  helper: string;
};

const REVIEW_HELPERS: Readonly<Record<NewSessionReviewFocus, string>> = {
  project: "Enter choose project",
  name: "Enter edit name",
  agent: "Enter choose agent",
  create: "Enter create session",
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
    { id: "project", label: "Project (P)", value: project?.label ?? "-" },
    { id: "name", label: "Name (N)", value: state.title },
    {
      id: "agent",
      label: "Agent (A)",
      value: harness?.label ?? state.selectedHarness,
      status: { glyph: "●", text: status, tone: status },
    },
  ];
  return {
    fields,
    create: {
      label: "Create session",
      shortcut: "C",
      disabled: !validateNewSessionCreate(snapshot, state).ok,
    },
    helper: REVIEW_HELPERS[state.reviewFocus],
  };
}
