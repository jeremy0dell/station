import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ConfigError,
  loadConfig,
  setTuiWidgetsInConfig,
  type TuiConfig,
  type TuiWidgetConfig,
} from "@station/config";
import type { createTuiStore } from "@station/dashboard-core";
import { safeErrorFromUnknown } from "@station/runtime";

type TuiStoreApi = ReturnType<typeof createTuiStore>;

export type StationTuiConfigLoadResult = {
  config?: TuiConfig;
  configPath?: string;
  warning?: string;
};

export async function loadStationTuiConfig(options?: {
  env?: Record<string, string | undefined>;
  path?: string;
}): Promise<StationTuiConfigLoadResult> {
  const configPath = options?.path ?? configPathFromEnv(options?.env);
  try {
    const loaded =
      configPath === undefined ? await loadConfig() : await loadConfig({ configPath });
    const result: StationTuiConfigLoadResult = {};
    if (loaded.config.tui !== undefined) {
      result.config = loaded.config.tui;
    }
    result.configPath = loaded.configPath;
    const sectionWarning = loaded.diagnostics.find(
      (diagnostic) => diagnostic.code === "CONFIG_TUI_SECTION_INVALID",
    );
    if (sectionWarning !== undefined) {
      result.warning = sectionWarning.message;
    }
    return result;
  } catch (cause) {
    if (cause instanceof ConfigError && cause.code === "CONFIG_FILE_NOT_FOUND") {
      return {};
    }
    const error =
      cause instanceof ConfigError
        ? cause.toSafeError()
        : safeErrorFromUnknown(cause, {
            tag: "StationConfigError",
            code: "STATION_TUI_CONFIG_LOAD_FAILED",
            message: "Could not load STATION TUI widget config",
          });
    return {
      warning: `${error.message}; widgets disabled.`,
    };
  }
}

export type WidgetConfigWrites = {
  /** Stop observing and resolve after every queued or in-flight edit is durable. */
  dispose(): Promise<void>;
  /** Resolve after every currently queued or in-flight widget edit is durable. */
  flush(): Promise<void>;
};

type WidgetChange = {
  before: readonly TuiWidgetConfig[];
  after: readonly TuiWidgetConfig[];
};

const WIDGET_LOCK_TIMEOUT_MS = 5_000;
const WIDGET_LOCK_WAIT_MS = 10;
const WIDGET_LOCK_OWNER_GRACE_MS = 100;
const WIDGET_LOCK_OWNER_PREFIX = "owner-";

/**
 * Persist each local widget transition against config.toml as the authority.
 * A cross-process lock serializes reload/rebase/write, so stale native and popup
 * stores preserve independent edits instead of replacing one another's arrays.
 * `flush()` preserves observation; `dispose()` detaches and awaits durability.
 */
export function startWidgetConfigWrites(
  stationViewStore: TuiStoreApi,
  configPath: string,
): WidgetConfigWrites {
  let writes = Promise.resolve();
  let disposed = false;

  const reportWriteFailure = (cause: unknown): void => {
    const error = safeErrorFromUnknown(cause, {
      tag: "StationWidgetConfigError",
      code: "STATION_WIDGET_CONFIG_SAVE_FAILED",
      message: "Could not save widgets to config.toml.",
    });
    stationViewStore.getState().pushToast({
      kind: "error",
      message: "Could not save widgets to config.toml.",
      hint: error.message,
    });
  };

  const detach = stationViewStore.subscribe((state, previous) => {
    if (state.widgets === previous.widgets) {
      return;
    }
    const change = { before: previous.widgets, after: state.widgets };
    writes = writes
      .then(() => persistWidgetChange(configPath, change))
      .catch(reportWriteFailure);
  });

  return {
    dispose: async (): Promise<void> => {
      if (!disposed) {
        disposed = true;
        detach();
      }
      await writes;
    },
    flush: () => writes,
  };
}

async function persistWidgetChange(configPath: string, change: WidgetChange): Promise<void> {
  await withWidgetConfigLock(configPath, async () => {
    const loaded = await loadConfig({ configPath });
    const latest = loaded.config.tui?.widgets ?? [];
    await setTuiWidgetsInConfig({ configPath, widgets: rebaseWidgetChange(change, latest) });
  });
}

function rebaseWidgetChange(
  change: WidgetChange,
  latest: readonly TuiWidgetConfig[],
): readonly TuiWidgetConfig[] {
  if (isDeepStrictEqual(change.before, change.after)) {
    return latest;
  }
  if (isDeepStrictEqual(change.before, latest)) {
    return change.after;
  }

  // A stale store may safely replay over widgets another surface only appended.
  // Any removal, toggle, or reorder of its base fails closed instead of being overwritten.
  const remoteAdditions: TuiWidgetConfig[] = [];
  let baseIndex = 0;
  for (const widget of latest) {
    const expected = change.before[baseIndex];
    if (expected !== undefined && isDeepStrictEqual(widget, expected)) {
      baseIndex += 1;
    } else {
      remoteAdditions.push(widget);
    }
  }
  if (baseIndex !== change.before.length) {
    throw new Error(
      "Widget config changed in another Station surface; reopen widget settings and retry this edit.",
    );
  }
  return [...change.after, ...remoteAdditions];
}

async function withWidgetConfigLock<T>(configPath: string, action: () => Promise<T>): Promise<T> {
  const lockDir = join(dirname(configPath), `.${basename(configPath)}.station-widgets.lock`);
  const deadline = Date.now() + WIDGET_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      if (!(await widgetLockHasLiveOwner(lockDir))) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for widget config lock ${lockDir}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, WIDGET_LOCK_WAIT_MS));
      continue;
    }

    try {
      await writeFile(join(lockDir, `${WIDGET_LOCK_OWNER_PREFIX}${process.pid}`), "", {
        flag: "wx",
        mode: 0o600,
      });
      return await action();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

async function widgetLockHasLiveOwner(lockDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const owner = names.find((name) => name.startsWith(WIDGET_LOCK_OWNER_PREFIX));
  if (owner === undefined) {
    const stats = await lstat(lockDir).catch(() => undefined);
    return stats !== undefined && Date.now() - stats.mtimeMs < WIDGET_LOCK_OWNER_GRACE_MS;
  }
  const pid = Number(owner.slice(WIDGET_LOCK_OWNER_PREFIX.length));
  return Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function configPathFromEnv(env: Record<string, string | undefined> | undefined): string | undefined {
  const value = env?.STATION_CONFIG_PATH?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
