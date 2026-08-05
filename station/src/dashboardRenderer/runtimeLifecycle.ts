export type DashboardRendererRuntimeLifecycle = {
  /** Release renderer resources immediately, then drain dashboard work before stopping the client. */
  dispose(): Promise<void>;
  /** Start synchronous best-effort cleanup for Node/Bun's non-extendable exit event. */
  disposeForProcessExit(): void;
};

export type DashboardRendererRuntimeLifecycleOptions = {
  releaseRendererResources(): void;
  disposeWidgetWrites(): Promise<void>;
  disposeDashboardRuntime(): Promise<void>;
  disposeRuntimeCapabilities(): void | Promise<void>;
  stopClient(): Promise<void>;
};

export type DashboardHotRenderer = { destroy(): void };
export type DashboardRendererHotSlots = typeof globalThis & {
  __stationDashboardHotDispose?: Promise<void>;
  __stationDashboardHotRenderer?: DashboardHotRenderer;
};

/** Return the process-global standalone renderer slots retained across Bun HMR. */
export function dashboardRendererHotSlots(): DashboardRendererHotSlots {
  return globalThis as DashboardRendererHotSlots;
}

/** Await the previous standalone dashboard settlement before replacement composition. */
export function waitForDashboardRendererHotDisposal(
  slots: DashboardRendererHotSlots,
): Promise<void> {
  return slots.__stationDashboardHotDispose ?? Promise.resolve();
}

/** Publish one standalone HMR disposer with compare-and-delete stale protection. */
export function beginDashboardRendererHotDisposal(
  slots: DashboardRendererHotSlots,
  dispose: () => Promise<void>,
): Promise<void> {
  let disposal: Promise<void>;
  try {
    disposal = dispose();
  } catch (error: unknown) {
    disposal = Promise.reject(error);
  }
  slots.__stationDashboardHotDispose = disposal;
  const clear = (): void => {
    // A stale disposer must not erase a newer generation's settlement barrier.
    if (slots.__stationDashboardHotDispose === disposal) {
      delete slots.__stationDashboardHotDispose;
    }
  };
  disposal.then(clear, clear);
  return disposal;
}

/**
 * Create repeat-safe standalone disposal that releases OpenTUI ownership
 * synchronously and drains dashboard operations before client shutdown.
 */
export function createDashboardRendererRuntimeLifecycle(
  options: DashboardRendererRuntimeLifecycleOptions,
): DashboardRendererRuntimeLifecycle {
  let released = false;
  let widgetSettlement: Promise<void> | undefined;
  let dashboardSettlement: Promise<void> | undefined;
  let capabilitySettlement: Promise<void> | undefined;
  let clientSettlement: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;

  const releaseRendererResources = (): void => {
    if (released) {
      return;
    }
    released = true;
    options.releaseRendererResources();
  };
  const disposeWidgetWrites = (): Promise<void> => {
    widgetSettlement ??= invoke(options.disposeWidgetWrites);
    return widgetSettlement;
  };
  const disposeDashboardRuntime = (): Promise<void> => {
    dashboardSettlement ??= invoke(options.disposeDashboardRuntime);
    return dashboardSettlement;
  };
  const disposeRuntimeCapabilities = (): Promise<void> => {
    capabilitySettlement ??= invoke(options.disposeRuntimeCapabilities);
    return capabilitySettlement;
  };
  const stopClient = (): Promise<void> => {
    clientSettlement ??= invoke(options.stopClient);
    return clientSettlement;
  };

  return {
    dispose: (): Promise<void> => {
      if (disposal !== undefined) {
        return disposal;
      }
      releaseRendererResources();
      const dashboard = disposeDashboardRuntime();
      const widgets = disposeWidgetWrites();
      const capabilities = dashboard.then(disposeRuntimeCapabilities, disposeRuntimeCapabilities);
      const client = capabilities.then(stopClient, stopClient);
      disposal = Promise.allSettled([dashboard, widgets, capabilities, client]).then(
        () => undefined,
      );
      return disposal;
    },
    disposeForProcessExit: (): void => {
      releaseRendererResources();
      disposeDashboardRuntime();
      disposeWidgetWrites();
      disposeRuntimeCapabilities();
      stopClient();
    },
  };
}

function invoke(effect: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(effect());
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}
