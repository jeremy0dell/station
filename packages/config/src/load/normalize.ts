import type { ChildNormalizers, KeyMap, MutableRecord } from "./common.js";
import { isRecord } from "./common.js";

export function normalizeGlobalConfig(value: unknown): unknown {
  return normalizeObject(
    value,
    {
      schema_version: "schemaVersion",
    },
    {
      observer: normalizeObserverConfig,
      defaults: normalizeGlobalDefaults,
      worktree: normalizeWorktreeProvidersConfig,
      terminal: normalizeTerminalProvidersConfig,
      harness: normalizeHarnessProvidersConfig,
      featureFlags: normalizeFeatureFlagsConfig,
      hooks: normalizeHooksConfig,
      tui: normalizeTuiConfig,
      repository: normalizeRepositoryProvidersConfig,
      observability: normalizeObservabilityConfig,
      projects: normalizeProjects,
    },
  );
}

export function normalizeProjectLocalConfig(value: unknown): unknown {
  return normalizeObject(
    value,
    {
      schema_version: "schemaVersion",
    },
    {
      defaults: normalizeProjectDefaults,
      commands: preserveRecordKeys,
      display: normalizeDisplayConfig,
    },
  );
}

function normalizeObserverConfig(value: unknown): unknown {
  return normalizeObject(value, {
    auto_start: "autoStart",
    auto_start_from_hooks: "autoStartFromHooks",
    idle_shutdown_minutes: "idleShutdownMinutes",
    reconcile_interval_ms: "reconcileIntervalMs",
    socket_path: "socketPath",
    state_dir: "stateDir",
  });
}

function normalizeGlobalDefaults(value: unknown): unknown {
  return normalizeObject(value, {
    worktree_provider: "worktreeProvider",
    default_branch: "defaultBranch",
    harness_permission_mode: "harnessPermissionMode",
  });
}

function normalizeWorktreeProvidersConfig(value: unknown): unknown {
  return normalizeObject(value, {}, { worktrunk: normalizeWorktreeWorktrunkConfig });
}

function normalizeWorktreeWorktrunkConfig(value: unknown): unknown {
  return normalizeObject(value, {
    config_path: "configPath",
    include_main: "includeMain",
    include_external: "includeExternal",
    use_lifecycle_hooks: "useLifecycleHooks",
    hook_mode: "hookMode",
    breadcrumb_location: "breadcrumbLocation",
  });
}

function normalizeTerminalProvidersConfig(value: unknown): unknown {
  return normalizeObject(value, {}, { tmux: normalizeTmuxConfig });
}

function normalizeTmuxConfig(value: unknown): unknown {
  return normalizeObject(value, {
    session_prefix: "sessionPrefix",
    workbench_session: "workbenchSession",
    window_naming: "windowNaming",
    primary_agent_pane: "primaryAgentPane",
    popup_width: "popupWidth",
    popup_height: "popupHeight",
    popup_position: "popupPosition",
  });
}

function normalizeHarnessProvidersConfig(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([providerId, providerConfig]) => [
      providerId,
      normalizeHarnessProviderConfig(providerConfig),
    ]),
  );
}

function normalizeHarnessProviderConfig(value: unknown): unknown {
  return normalizeObject(value, {
    permission_mode: "permissionMode",
    sandbox_mode: "sandboxMode",
    approval_policy: "approvalPolicy",
    install_hooks: "installHooks",
  });
}

function normalizeFeatureFlagsConfig(value: unknown): unknown {
  return normalizeObject(value, {
    session_resume_agent: "sessionResumeAgent",
    station_persistent_agents: "stationPersistentAgents",
  });
}

function normalizeHooksConfig(value: unknown): unknown {
  return normalizeObject(value, {}, { event: normalizeEventHookConfigs });
}

function normalizeTuiConfig(value: unknown): unknown {
  return normalizeObject(
    value,
    {},
    { widgets: normalizeTuiWidgetConfigs, island: normalizeTuiIslandConfig },
  );
}

function normalizeTuiIslandConfig(value: unknown): unknown {
  return normalizeObject(value);
}

function normalizeTuiWidgetConfigs(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map(normalizeTuiWidgetConfig);
}

function normalizeTuiWidgetConfig(value: unknown): unknown {
  return normalizeObject(value, {}, { zones: normalizeTuiTimezoneZones });
}

function normalizeTuiTimezoneZones(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((zone) => normalizeObject(zone));
}

function normalizeEventHookConfigs(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map(normalizeEventHookConfig);
}

function normalizeEventHookConfig(value: unknown): unknown {
  return normalizeObject(
    value,
    {
      timeout_ms: "timeoutMs",
    },
    {
      filter: normalizeEventHookFilter,
    },
  );
}

function normalizeEventHookFilter(value: unknown): unknown {
  return normalizeObject(value, {
    agent_state: "agentState",
    change_source: "changeSource",
    harness_event_type: "harnessEventType",
  });
}

function normalizeRepositoryProvidersConfig(value: unknown): unknown {
  return normalizeObject(value, {}, { github: normalizeGithubRepositoryConfig });
}

function normalizeGithubRepositoryConfig(value: unknown): unknown {
  return normalizeObject(value, {
    timeout_ms: "timeoutMs",
  });
}

function normalizeObservabilityConfig(value: unknown): unknown {
  return normalizeObject(value, {}, { retention: normalizeRetentionConfig });
}

function normalizeRetentionConfig(value: unknown): unknown {
  return normalizeObject(
    value,
    {
      max_days: "maxDays",
      max_total_mb: "maxTotalMb",
      max_file_mb: "maxFileMb",
      max_files_per_component: "maxFilesPerComponent",
    },
    {
      components: normalizeRetentionComponentsConfig,
      sqlite: normalizeRetentionSqliteConfig,
      debugBundles: normalizeRetentionDebugBundlesConfig,
      hookSpool: normalizeRetentionHookSpoolConfig,
    },
  );
}

function normalizeRetentionComponentsConfig(value: unknown): unknown {
  return normalizeObject(value, {
    observer_max_mb: "observerMaxMb",
    cli_max_mb: "cliMaxMb",
    tui_max_mb: "tuiMaxMb",
    hook_runner_max_mb: "hookRunnerMaxMb",
    provider_max_mb: "providerMaxMb",
  });
}

function normalizeRetentionSqliteConfig(value: unknown): unknown {
  return normalizeObject(value, {
    events_max_days: "eventsMaxDays",
    commands_max_days: "commandsMaxDays",
    errors_max_days: "errorsMaxDays",
    provider_observations_max_days: "providerObservationsMaxDays",
  });
}

function normalizeRetentionDebugBundlesConfig(value: unknown): unknown {
  return normalizeObject(value, {
    max_bundles: "maxBundles",
    max_days: "maxDays",
  });
}

function normalizeRetentionHookSpoolConfig(value: unknown): unknown {
  return normalizeObject(value, {
    delivered_delete_immediately: "deliveredDeleteImmediately",
    failed_max_days: "failedMaxDays",
    failed_max_items: "failedMaxItems",
  });
}

function normalizeProjects(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map(normalizeProjectConfig);
}

function normalizeProjectConfig(value: unknown): unknown {
  return normalizeObject(
    value,
    {
      default_branch: "defaultBranch",
      local_config: "localConfig",
    },
    {
      defaults: normalizeProjectDefaults,
      worktrunk: normalizeProjectWorktrunkConfig,
      commands: preserveRecordKeys,
      env: preserveRecordKeys,
      display: normalizeDisplayConfig,
      localConfig: normalizeProjectLocalConfigRef,
      recoveryBreadcrumbs: normalizeProjectRecoveryBreadcrumbsConfig,
    },
  );
}

function normalizeProjectDefaults(value: unknown): unknown {
  return normalizeObject(value);
}

function normalizeProjectWorktrunkConfig(value: unknown): unknown {
  return normalizeObject(value);
}

function normalizeDisplayConfig(value: unknown): unknown {
  return normalizeObject(value, {
    sort_order: "sortOrder",
  });
}

function normalizeProjectLocalConfigRef(value: unknown): unknown {
  return normalizeObject(value);
}

function normalizeProjectRecoveryBreadcrumbsConfig(value: unknown): unknown {
  return normalizeObject(value);
}

function normalizeObject(
  value: unknown,
  keyMap: KeyMap = {},
  childNormalizers: ChildNormalizers = {},
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const normalized: MutableRecord = {};

  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = keyMap[key] ?? snakeToCamel(key);
    // Child normalizers are keyed by the normalized name, so explicit maps and snake_case compose.
    const childNormalizer = childNormalizers[normalizedKey];
    normalized[normalizedKey] =
      childNormalizer === undefined ? childValue : childNormalizer(childValue);
  }

  return normalized;
}

function preserveRecordKeys(value: unknown): unknown {
  return value;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
