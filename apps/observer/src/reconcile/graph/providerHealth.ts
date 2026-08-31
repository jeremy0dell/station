import type {
  ProviderHealth,
  ProviderId,
  SafeError,
  StationAlert,
  StationSnapshot,
} from "@station/contracts";
import type { ObserverGraphInput } from "./evidence.js";

export function projectProviderHealthOntoSnapshot(input: {
  snapshot: StationSnapshot;
  health: ProviderHealth;
  projectedAt: string;
}): StationSnapshot {
  const providerHealth: Record<string, ProviderHealth> = {
    ...input.snapshot.providerHealth,
    [input.health.provider]: input.health,
  };
  const providerAlertIds = new Set([
    providerHealthAlertId(input.health.provider, "degraded"),
    providerHealthAlertId(input.health.provider, "unavailable"),
  ]);
  const alerts = [
    ...input.snapshot.alerts.filter((alert) => !providerAlertIds.has(alert.id)),
    ...alertsFromProviderHealth({ [input.health.provider]: input.health }, input.projectedAt),
  ];
  const healthy =
    !alerts.some((alert) => alert.severity === "error") &&
    Object.values(providerHealth).every((health) => health.status !== "unavailable");

  return {
    ...input.snapshot,
    generatedAt: input.projectedAt,
    observer: {
      ...input.snapshot.observer,
      healthy,
    },
    providerHealth,
    projects: input.snapshot.projects.map((project) =>
      project.health.provider === input.health.provider
        ? { ...project, health: input.health }
        : project,
    ),
    alerts,
  };
}

export function unknownProviderHealth(input: ObserverGraphInput): ProviderHealth {
  return {
    provider: input.worktreeProviderId,
    providerType: "worktree",
    status: "unknown",
    lastCheckedAt: input.generatedAt,
  };
}

export function alertsFromProviderHealth(
  providerHealth: Record<string, ProviderHealth>,
  generatedAt: string,
): StationAlert[] {
  return Object.values(providerHealth)
    .filter((health) => health.status === "unavailable" || health.status === "degraded")
    .map((health) => {
      const alert: StationAlert = {
        id: providerHealthAlertId(health.provider, health.status),
        severity: health.status === "unavailable" ? "error" : "warn",
        message:
          health.lastError?.message ??
          `The ${health.providerType} provider ${health.provider} is ${health.status}.`,
        provider: health.provider,
        createdAt: generatedAt,
      };
      if (health.lastError?.code !== undefined) {
        alert.code = health.lastError.code;
      }
      return alert;
    });
}

function providerHealthAlertId(providerId: string, status: ProviderHealth["status"]): string {
  return `alert_${providerId}_${status}`;
}

export function safeErrorToProviderHealth(input: {
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  lastCheckedAt: string;
  lastError: SafeError;
  capabilities?: Record<string, boolean>;
  latencyMs?: number;
}): ProviderHealth {
  const health: ProviderHealth = {
    provider: input.providerId,
    providerType: input.providerType,
    status: "unavailable",
    lastCheckedAt: input.lastCheckedAt,
    lastError: input.lastError,
  };
  if (input.latencyMs !== undefined) health.latencyMs = input.latencyMs;
  if (input.capabilities !== undefined) health.capabilities = input.capabilities;
  return health;
}
