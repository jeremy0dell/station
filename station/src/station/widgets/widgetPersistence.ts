import { setTuiWidgetsInConfig, type TuiWidgetConfig } from "@station/config";
import type { TuiStore } from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";

export type WidgetConfigPersistenceOptions = {
  configPath: string;
  save?: (widgets: readonly TuiWidgetConfig[]) => Promise<void>;
};

export type WidgetConfigPersistence = {
  start(): () => void;
};

export function createWidgetConfigPersistence(
  store: StoreApi<TuiStore>,
  options: WidgetConfigPersistenceOptions | undefined,
): WidgetConfigPersistence | undefined {
  if (options === undefined) {
    return undefined;
  }
  const save =
    options.save ??
    (async (widgets) => {
      await setTuiWidgetsInConfig({ configPath: options.configPath, widgets });
    });
  return {
    start: () => {
      let previous = store.getState().widgets;
      let pending: readonly TuiWidgetConfig[] | undefined;
      let saving = false;

      const drain = async (): Promise<void> => {
        if (saving) {
          return;
        }
        saving = true;
        try {
          while (pending !== undefined) {
            const widgets = pending;
            pending = undefined;
            try {
              await save(widgets);
            } catch (error) {
              store.getState().pushToast({
                kind: "error",
                message: "Could not save widgets to config.toml.",
                hint: error instanceof Error ? error.message : options.configPath,
              });
            }
          }
        } finally {
          saving = false;
        }
      };

      return store.subscribe((state) => {
        if (state.widgets === previous) {
          return;
        }
        previous = state.widgets;
        pending = state.widgets;
        void drain();
      });
    },
  };
}
