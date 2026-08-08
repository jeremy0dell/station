import {
  invokeCleanup,
  settleCleanupPromises,
  settleCleanupSteps,
  startCleanupStepsBestEffort,
  type CleanupStep,
} from "../lifecycle/cleanup.js";

export type DashboardRendererRuntimeLifecycle = {
  /** Release renderer resources immediately, then drain dashboard work before stopping the client. */
  dispose(): Promise<void>;
  /** Start synchronous best-effort cleanup for Node/Bun's non-extendable exit event. */
  disposeForProcessExit(): void;
};

export type DashboardRendererRuntimeLifecycleOptions = {
  releaseRendererResources: readonly CleanupStep[];
  disposeWidgetWrites(): Promise<void>;
  disposeDashboardRuntime(): Promise<void>;
  disposeRuntimeCapabilities(): void | Promise<void>;
  stopClient(): Promise<void>;
};

/**
 * Create repeat-safe standalone disposal that releases OpenTUI ownership
 * synchronously and drains dashboard operations before client shutdown.
 */
export function createDashboardRendererRuntimeLifecycle(
  options: DashboardRendererRuntimeLifecycleOptions,
): DashboardRendererRuntimeLifecycle {
  let rendererSettlement: Promise<void> | undefined;
  let widgetSettlement: Promise<void> | undefined;
  let dashboardSettlement: Promise<void> | undefined;
  let capabilitySettlement: Promise<void> | undefined;
  let clientSettlement: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;

  const releaseRendererResources = (): Promise<void> => {
    rendererSettlement ??= settleCleanupSteps(
      options.releaseRendererResources,
      "Standalone renderer resource cleanup failed.",
    );
    return rendererSettlement;
  };
  const disposeWidgetWrites = (): Promise<void> => {
    widgetSettlement ??= invokeCleanup(options.disposeWidgetWrites);
    return widgetSettlement;
  };
  const disposeDashboardRuntime = (): Promise<void> => {
    dashboardSettlement ??= invokeCleanup(options.disposeDashboardRuntime);
    return dashboardSettlement;
  };
  const disposeRuntimeCapabilities = (): Promise<void> => {
    capabilitySettlement ??= invokeCleanup(options.disposeRuntimeCapabilities);
    return capabilitySettlement;
  };
  const stopClient = (): Promise<void> => {
    clientSettlement ??= invokeCleanup(options.stopClient);
    return clientSettlement;
  };

  return {
    dispose: (): Promise<void> => {
      if (disposal !== undefined) {
        return disposal;
      }

      let resolveDisposal!: () => void;
      let rejectDisposal!: (error: unknown) => void;
      disposal = new Promise<void>((resolve, reject) => {
        resolveDisposal = resolve;
        rejectDisposal = reject;
      });

      const renderer = releaseRendererResources();
      // Dashboard disposal closes admission synchronously; capability disposal can then
      // reject popup requests that already-admitted dashboard work is awaiting.
      const dashboard = disposeDashboardRuntime();
      const widgets = disposeWidgetWrites();
      const capabilities = disposeRuntimeCapabilities();
      const client = Promise.allSettled([dashboard, capabilities]).then(() => stopClient());
      const settlement = settleCleanupPromises(
        [renderer, dashboard, widgets, capabilities, client],
        "Standalone dashboard cleanup failed.",
      );
      settlement.then(resolveDisposal, rejectDisposal);
      return disposal;
    },
    disposeForProcessExit: (): void => {
      void releaseRendererResources().catch(() => {
        // The exit event is non-extendable, but the remaining releases still start below.
      });
      startCleanupStepsBestEffort([
        disposeDashboardRuntime,
        disposeWidgetWrites,
        disposeRuntimeCapabilities,
        stopClient,
      ]);
    },
  };
}
