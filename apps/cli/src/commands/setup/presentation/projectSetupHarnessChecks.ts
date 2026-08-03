import type {
  SetupPlan as CoreSetupPlan,
  HarnessTrackingAssessment,
  SupportedHarnessId,
} from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { SetupFacts } from "../adapters/inspectionTypes.js";
import type {
  SetupDisplayDetail,
  SetupPresentationHarnessSelection,
  SetupViewCheck,
} from "./setupViewTypes.js";

export function projectSetupHarnessSelection(
  plan: CoreSetupPlan,
): SetupPresentationHarnessSelection {
  if (plan.selection.outcome !== "selected") {
    return { requiredHarnessIds: [], source: "unresolved" };
  }
  return {
    requiredHarnessIds: plan.selection.requiredHarnessIds,
    source: plan.selection.source,
    defaultHarness: plan.selection.defaultHarness,
  };
}

export function projectSetupHarnessChecks(input: {
  readonly plan: CoreSetupPlan;
  readonly facts: SetupFacts;
  readonly selection: SetupPresentationHarnessSelection;
}): readonly SetupViewCheck[] {
  const { plan, facts, selection } = input;
  const available = facts.harnesses.filter((harness) => harness.status === "ok");
  const unavailable = selection.requiredHarnessIds.filter(
    (id) => !available.some((harness) => harness.id === id),
  );
  const harnessDetails: SetupDisplayDetail[] = [];
  if (selection.defaultHarness !== undefined) {
    harnessDetails.push({
      label: setupMessageRef("detail.default-agent"),
      value: selection.defaultHarness,
    });
  }
  if (selection.requiredHarnessIds.length > 0) {
    harnessDetails.push({
      label: setupMessageRef("detail.enabled-agents"),
      value: selection.requiredHarnessIds.join(","),
    });
  }
  if (unavailable.length > 0) {
    harnessDetails.push({
      label: setupMessageRef("detail.unavailable-agents"),
      value: unavailable.join(","),
    });
  }

  const harness = projectHarnessCheck({
    plan,
    facts,
    selection,
    available,
    unavailable,
    details: harnessDetails,
  });
  const tracking = plan.evidence.harnessTracking.map((trackingFact) =>
    projectHarnessTrackingCheck({
      plan,
      facts,
      selection,
      harnessId: trackingFact.harnessId,
    }),
  );
  return [harness, ...tracking];
}

function projectHarnessCheck(input: {
  readonly plan: CoreSetupPlan;
  readonly facts: SetupFacts;
  readonly selection: SetupPresentationHarnessSelection;
  readonly available: readonly SetupFacts["harnesses"][number][];
  readonly unavailable: readonly SupportedHarnessId[];
  readonly details: SetupViewCheck["details"];
}): SetupViewCheck {
  const { plan, facts, selection, available, unavailable, details } = input;
  if (plan.selection.outcome !== "selected") {
    const explanation =
      available.length > 1
        ? setupMessageRef("check.harness-selection-ambiguous", {
            harnesses: available.map((harness) => harness.id).join(", "),
          })
        : available.length === 0
          ? setupMessageRef("check.harness-none-available")
          : setupMessageRef("check.harness-selection-unresolved");
    return {
      id: "harness",
      tier: "required",
      status: "missing",
      label: setupMessageRef("label.agent-cli"),
      explanation,
      details,
    };
  }
  if (unavailable.length > 0) {
    return {
      id: "harness",
      tier: "required",
      status: "missing",
      label: setupMessageRef("label.agent-cli"),
      explanation:
        selection.source === "configured"
          ? setupMessageRef("check.harness-configured-unavailable", {
              harnessId: unavailable[0] ?? "unknown",
            })
          : setupMessageRef("check.harness-explicit-unavailable", {
              harnessIds: unavailable.join(", "),
            }),
      details,
    };
  }
  const labels = selection.requiredHarnessIds.map(
    (id) => facts.harnesses.find((harness) => harness.id === id)?.label ?? id,
  );
  const explanation =
    selection.source === "inferred"
      ? setupMessageRef("check.harness-inferred", { harness: labels[0] ?? "Agent" })
      : selection.source === "explicit"
        ? setupMessageRef("check.harness-explicit", { harnesses: labels.join(", ") })
        : setupMessageRef("check.harness-configured", { harness: labels[0] ?? "Agent" });
  return {
    id: "harness",
    tier: "required",
    status: "ok",
    label: setupMessageRef("label.agent-cli"),
    explanation,
    details,
  };
}

function projectHarnessTrackingCheck(input: {
  readonly plan: CoreSetupPlan;
  readonly facts: SetupFacts;
  readonly selection: SetupPresentationHarnessSelection;
  readonly harnessId: SupportedHarnessId;
}): SetupViewCheck {
  const { plan, facts, selection, harnessId } = input;
  const assessment = plan.evidence.harnessTracking.find(
    (tracking) => tracking.harnessId === harnessId,
  )?.assessment;
  if (assessment === undefined) {
    throw new Error(`Semantic tracking evidence is missing for ${harnessId}.`);
  }
  const required = selection.requiredHarnessIds.includes(harnessId);
  const fact = facts.harnessTracking.find((candidate) => candidate.harnessId === harnessId);
  const label = facts.harnesses.find((candidate) => candidate.id === harnessId)?.label ?? harnessId;
  const unavailableStatus = required ? "missing" : "warning";
  const presentation = trackingPresentation({
    assessment,
    detail: fact?.detail,
    harnessId,
    label,
    unavailableStatus,
    required,
  });
  return {
    id: `harness-tracking:${harnessId}`,
    tier: required ? "required" : "recommended",
    status: presentation.status,
    label: setupMessageRef("label.harness-tracking", { harness: label }),
    explanation: presentation.explanation,
    details: trackingOwnershipDetails(fact),
  };
}

function trackingOwnershipDetails(
  fact: SetupFacts["harnessTracking"][number] | undefined,
): readonly SetupDisplayDetail[] {
  const ownership = fact?.ownership;
  if (ownership === undefined) return [];
  const details: SetupDisplayDetail[] = [
    { label: setupMessageRef("detail.tracking-owner-status"), value: ownership.status },
    {
      label: setupMessageRef("detail.requested-launcher"),
      value: ownership.requested.launcher,
    },
  ];
  if (ownership.status === "same-owner" || ownership.status === "different-owner") {
    details.push({
      label: setupMessageRef("detail.current-launcher"),
      value: ownership.currentLauncher,
    });
  }
  return details;
}

function trackingPresentation(input: {
  readonly assessment: HarnessTrackingAssessment;
  readonly detail: string | undefined;
  readonly harnessId: SupportedHarnessId;
  readonly label: string;
  readonly unavailableStatus: "missing" | "warning";
  readonly required: boolean;
}): Pick<SetupViewCheck, "status" | "explanation"> {
  const { assessment, detail, harnessId, label, unavailableStatus, required } = input;
  switch (assessment.state) {
    case "not-applicable":
      return {
        status: required ? "ok" : "skipped",
        explanation: setupMessageRef("check.tracking-not-applicable", { harness: label }),
      };
    case "probe-failed":
      return {
        status: unavailableStatus,
        explanation:
          detail === undefined
            ? setupMessageRef("check.tracking-probe-failed", { harnessId })
            : setupMessageRef("check.evidence", { message: detail }),
      };
    case "disabled":
      return {
        status: unavailableStatus,
        explanation: setupMessageRef("check.tracking-disabled", { harness: label }),
      };
    case "artifact-missing-or-drifted":
      return {
        status: unavailableStatus,
        explanation:
          detail === undefined
            ? setupMessageRef("check.tracking-missing", { harnessId })
            : setupMessageRef("check.evidence", { message: detail }),
      };
    case "prepared":
      return {
        status: "ok",
        explanation: setupMessageRef("check.tracking-prepared", { harness: label }),
      };
  }
}
