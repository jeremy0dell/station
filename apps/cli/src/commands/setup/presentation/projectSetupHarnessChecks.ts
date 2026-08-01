import type { SetupPlan as CoreSetupPlan, HarnessTrackingAssessment } from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import { relevantHarnessTrackingIds, type SetupHarnessSelection } from "../harnessSelection.js";
import type { SetupFacts, SupportedHarnessId } from "../model.js";
import type { SetupDisplayDetail, SetupViewCheck } from "./setupViewTypes.js";

export function projectSetupHarnessSelection(
  plan: CoreSetupPlan,
  facts: SetupFacts,
): SetupHarnessSelection {
  if (plan.selection.outcome !== "selected") {
    return { selected: [], requiredHarnessIds: [], source: "unresolved" };
  }
  return {
    selected: plan.selection.requiredHarnessIds.flatMap((harnessId) => {
      const harness = facts.harnesses.find(
        (candidate) => candidate.id === harnessId && candidate.status === "ok",
      );
      return harness === undefined ? [] : [harness];
    }),
    requiredHarnessIds: plan.selection.requiredHarnessIds,
    source: plan.selection.source,
    defaultHarness: plan.selection.defaultHarness,
  };
}

export function projectSetupHarnessChecks(
  plan: CoreSetupPlan,
  facts: SetupFacts,
  selection: SetupHarnessSelection,
): readonly SetupViewCheck[] {
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

  const harness = projectHarnessCheck(
    plan,
    facts,
    selection,
    available,
    unavailable,
    harnessDetails,
  );
  const tracking = relevantHarnessTrackingIds(facts, selection).map((harnessId) =>
    projectHarnessTrackingCheck(plan, facts, selection, harnessId),
  );
  return [harness, ...tracking];
}

function projectHarnessCheck(
  plan: CoreSetupPlan,
  facts: SetupFacts,
  selection: SetupHarnessSelection,
  available: readonly SetupFacts["harnesses"][number][],
  unavailable: readonly SupportedHarnessId[],
  details: SetupViewCheck["details"],
): SetupViewCheck {
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

function projectHarnessTrackingCheck(
  plan: CoreSetupPlan,
  facts: SetupFacts,
  selection: SetupHarnessSelection,
  harnessId: SupportedHarnessId,
): SetupViewCheck {
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
  const presentation = trackingPresentation(
    assessment,
    fact?.detail,
    harnessId,
    label,
    unavailableStatus,
    required,
  );
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

function trackingPresentation(
  assessment: HarnessTrackingAssessment,
  detail: string | undefined,
  harnessId: SupportedHarnessId,
  label: string,
  unavailableStatus: "missing" | "warning",
  required: boolean,
): Pick<SetupViewCheck, "status" | "explanation"> {
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
