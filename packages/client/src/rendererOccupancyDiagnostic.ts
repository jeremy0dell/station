/**
 * Observation-only bridge for temporary native-renderer occupancy diagnostics.
 * Callers record work only while the protocol transport owns an already-armed window.
 */
export {
  beginClientRuntimeEventRendererOccupancy,
  beginDashboardSourceRendererOccupancy,
  markClientRuntimeEventRendererOccupancy,
  markDashboardSourceRendererOccupancy,
  recordRootReactRendererOccupancy,
  rendererOccupancyDiagnosticEnabled,
} from "@station/protocol";
