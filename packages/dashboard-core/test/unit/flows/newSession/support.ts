import { newSessionIntentForInput } from "../../../../src/flows/newSession/actions.js";
import { transitionNewSessionFlow } from "../../../../src/flows/newSession/flow.js";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

export function createHarnessSnapshot(
  statuses: Partial<
    Record<"codex" | "opencode" | "scripted", "healthy" | "degraded" | "unavailable">
  > = {},
) {
  const snapshot = createDashboardSnapshot();
  return {
    ...snapshot,
    harnesses: [
      { id: "codex", label: "codex" },
      { id: "opencode", label: "opencode" },
      { id: "scripted", label: "scripted" },
    ],
    providerHealth: {
      ...snapshot.providerHealth,
      codex: harnessHealth("codex", statuses.codex ?? "healthy", snapshot.generatedAt),
      opencode: harnessHealth("opencode", statuses.opencode ?? "healthy", snapshot.generatedAt),
    },
  };
}

export function createProjectSnapshot(count: number) {
  const snapshot = createHarnessSnapshot();
  const baseProject = snapshot.projects[0];
  if (baseProject === undefined) throw new Error("expected project");
  return {
    ...snapshot,
    projects: Array.from({ length: count }, (_, index) => {
      const id = `project-${index + 1}`;
      return {
        ...baseProject,
        id,
        label: id,
        root: `/tmp/station/${id}`,
        defaults: {
          ...baseProject.defaults,
          harness: "codex",
        },
      };
    }),
    rows: [],
    sessions: [],
  };
}

export function typeName(
  initialState: NonNullable<ReturnType<typeof transitionNewSessionFlow>> & { mode: "editName" },
  value: string,
) {
  return value.split("").reduce((state, inputValue) => {
    const next = applyInput(state, inputValue);
    if (next.mode !== "editName") throw new Error("expected edit mode");
    return next;
  }, initialState);
}

export function applyInput(
  state: NonNullable<ReturnType<typeof transitionNewSessionFlow>>,
  value: string,
  key: Parameters<typeof newSessionIntentForInput>[1]["key"] = {},
) {
  const intent = newSessionIntentForInput(state, input(value, key));
  if (intent.type !== "transition") throw new Error("expected transition intent");
  const next = transitionNewSessionFlow(state, intent.action);
  if (next === undefined) throw new Error("expected state");
  return next;
}

export function input(
  value: string,
  key: Parameters<typeof newSessionIntentForInput>[1]["key"] = {},
): Parameters<typeof newSessionIntentForInput>[1] {
  return {
    input: value,
    key,
    token: "bbbbbb",
  };
}

function harnessHealth(
  providerId: string,
  status: "healthy" | "degraded" | "unavailable",
  lastCheckedAt: string,
) {
  return {
    provider: providerId,
    providerType: "harness" as const,
    status,
    lastCheckedAt,
  };
}
