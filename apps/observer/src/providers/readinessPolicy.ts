import { createHash } from "node:crypto";
import type {
  HarnessReadiness,
  HarnessReadinessAction,
  HarnessReadinessCompactStatus,
  HarnessReadinessFacts,
  HarnessReadinessFreshness,
  HarnessReadinessSummary,
  HarnessTracking,
} from "@station/contracts";
import type { HarnessReadinessRegistration } from "./registry.js";

export type DeriveHarnessReadinessInput = {
  registration: HarnessReadinessRegistration;
  facts: HarnessReadinessFacts;
  freshness: HarnessReadinessFreshness;
  trackingObserved: boolean;
  checkedAt?: string;
};

/**
 * POLICY
 *
 * Converts provider-owned facts and cache freshness into one provider-neutral
 * launch decision without performing probes or setup mutation.
 */
export function deriveHarnessReadiness(input: DeriveHarnessReadinessInput): HarnessReadiness {
  const tracking = normalizeTracking(input.facts.trackingSetup, input.trackingObserved);
  const resolution = resolveReadiness(input, tracking);
  const common = {
    provider: input.registration.provider.id,
    label: input.registration.label,
    kind: input.registration.kind,
    configuration: input.registration.configuration,
    authentication: input.facts.authentication,
    launchability: input.facts.launchability,
    trackingSetup: input.facts.trackingSetup,
    tracking,
    freshness: input.freshness,
    decision: resolution.decision,
    revision: revisionFor({
      configuration: input.registration.configuration,
      cli: input.facts.cli,
      authentication: input.facts.authentication,
      launchability: input.facts.launchability,
      trackingSetup: input.facts.trackingSetup,
      tracking,
      freshness: input.freshness,
      decision: resolution.decision,
      actions: resolution.actions,
    }),
    explanation: resolution.explanation,
    actions: resolution.actions,
    technicalDetails: input.facts.technicalDetails,
  };
  let readiness: HarnessReadiness;
  if (input.facts.cli === "available") {
    readiness = { ...common, cli: "available" };
    if (input.facts.installedVersion !== undefined) {
      readiness.installedVersion = input.facts.installedVersion;
    }
  } else {
    readiness = { ...common, cli: input.facts.cli };
  }
  if (input.facts.latestVersion !== undefined) {
    readiness.latestVersion = input.facts.latestVersion;
  }
  if (input.checkedAt !== undefined) {
    readiness.checkedAt = input.checkedAt;
  }
  return readiness;
}

export function summarizeHarnessReadiness(readiness: HarnessReadiness): HarnessReadinessSummary {
  const summary: HarnessReadinessSummary = {
    status: compactStatus(readiness),
    freshness: readiness.freshness,
    decision: readiness.decision,
    revision: readiness.revision,
  };
  if (readiness.checkedAt !== undefined) {
    summary.checkedAt = readiness.checkedAt;
  }
  return summary;
}

function compactStatus(readiness: HarnessReadiness): HarnessReadinessCompactStatus {
  if (readiness.configuration === "disabled") return "unknown";
  if (readiness.freshness === "checking") return "checking";
  if (readiness.freshness !== "fresh") return "unknown";
  if (readiness.cli === "missing") return "not_installed";
  if (readiness.cli === "unknown") return "unknown";
  if (readiness.authentication === "required") return "sign_in";
  if (readiness.authentication === "unknown") return "unknown";
  if (readiness.launchability !== "ready") return "unknown";
  if (readiness.configuration === "not_configured") return "needs_setup";
  if (readiness.tracking === "repair_needed") return "repair";
  if (readiness.tracking === "needs_preparation") return "needs_setup";
  if (readiness.tracking === "prepared_unverified") return "prepared";
  if (readiness.tracking === "observed") return "ready";
  return "unknown";
}

type ReadinessResolution = Pick<HarnessReadiness, "decision" | "explanation" | "actions">;

function resolveReadiness(
  input: DeriveHarnessReadinessInput,
  tracking: HarnessTracking,
): ReadinessResolution {
  const details = input.facts.technicalDetails.length > 0;
  const actions = (...primary: HarnessReadinessAction[]): HarnessReadinessAction[] =>
    withSecondaryActions(primary, details);

  if (input.registration.configuration === "disabled") {
    return unknown("This agent is disabled in Station configuration.", actions("check_again"));
  }
  if (input.freshness === "checking") {
    return unknown("Station is checking this agent.", actions());
  }
  if (input.freshness === "stale") {
    return unknown(
      "This readiness result is stale. Check again before use.",
      actions("check_again"),
    );
  }
  if (input.freshness === "failed") {
    return unknown("Station could not refresh this agent's readiness.", actions("check_again"));
  }
  if (input.facts.cli === "missing") {
    return {
      decision: "blocked_user_action",
      explanation: "Install this agent's CLI, then check again.",
      actions: actions("install_cli", "check_again"),
    };
  }
  if (input.facts.cli === "unknown") {
    return unknown(
      "Station could not determine whether this agent is installed.",
      actions("check_again"),
    );
  }
  if (input.facts.authentication === "required") {
    return {
      decision: "blocked_user_action",
      explanation: "Sign in to this agent, then check again.",
      actions: actions("sign_in", "check_again"),
    };
  }
  if (input.facts.authentication === "unknown") {
    return unknown(
      "Station could not determine this agent's authentication state.",
      actions("check_again"),
    );
  }
  if (input.facts.launchability === "blocked") {
    return {
      decision: "blocked_user_action",
      explanation: "This agent cannot currently launch.",
      actions: actions("check_again"),
    };
  }
  if (input.facts.launchability === "unknown") {
    return unknown(
      "Station could not determine whether this agent can launch.",
      actions("check_again"),
    );
  }
  if (input.registration.configuration === "not_configured") {
    if (input.registration.preparation.prepare) {
      return {
        decision: "prepare_then_launch",
        explanation: "Prepare this agent for Station before launching.",
        actions: actions("prepare", "check_again"),
      };
    }
    return unknown("This agent is not configured for Station.", actions("check_again"));
  }
  if (tracking === "repair_needed") {
    return {
      decision: input.registration.preparation.repair
        ? "prepare_then_launch"
        : "blocked_user_action",
      explanation: input.registration.preparation.repair
        ? "Repair this agent's Station tracking before launching."
        : "This Station-managed agent integration needs repair.",
      actions: input.registration.preparation.repair
        ? actions("repair", "check_again")
        : actions("check_again"),
    };
  }
  if (tracking === "needs_preparation") {
    if (input.registration.preparation.prepare) {
      return {
        decision: "prepare_then_launch",
        explanation: "Enable Station tracking before launching this agent.",
        actions: actions("prepare", "check_again"),
      };
    }
    return unknown("Station tracking is not prepared for this agent.", actions("check_again"));
  }
  if (tracking === "unsupported") {
    return unknown("Station tracking setup is unsupported for this agent.", actions("check_again"));
  }
  if (tracking === "unknown") {
    return unknown(
      "Station could not determine this agent's tracking setup.",
      actions("check_again"),
    );
  }
  if (tracking === "prepared_unverified") {
    return {
      decision: "launch_ready",
      explanation: "Station tracking is prepared but has not been observed yet.",
      actions: actions("use", "check_again"),
    };
  }
  return {
    decision: "launch_ready",
    explanation: "Station has observed this agent's tracking.",
    actions: actions("use", "check_again"),
  };
}

function unknown(explanation: string, actions: HarnessReadinessAction[]): ReadinessResolution {
  return { decision: "unknown", explanation, actions };
}

function withSecondaryActions(
  primary: readonly HarnessReadinessAction[],
  hasTechnicalDetails: boolean,
): HarnessReadinessAction[] {
  const actions = [...primary];
  if (hasTechnicalDetails && !actions.includes("technical_details")) {
    actions.push("technical_details");
  }
  return actions;
}

function normalizeTracking(
  setup: HarnessReadinessFacts["trackingSetup"],
  observed: boolean,
): HarnessTracking {
  switch (setup) {
    case "prepared":
      return observed ? "observed" : "prepared_unverified";
    case "needs_preparation":
    case "repair_needed":
    case "unsupported":
    case "unknown":
      return setup;
  }
}

function revisionFor(input: {
  configuration: HarnessReadiness["configuration"];
  cli: HarnessReadiness["cli"];
  authentication: HarnessReadiness["authentication"];
  launchability: HarnessReadiness["launchability"];
  trackingSetup: HarnessReadiness["trackingSetup"];
  tracking: HarnessReadiness["tracking"];
  freshness: HarnessReadiness["freshness"];
  decision: HarnessReadiness["decision"];
  actions: HarnessReadiness["actions"];
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
