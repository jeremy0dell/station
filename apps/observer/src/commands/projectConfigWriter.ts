import type { StationConfig } from "@station/config";
import type {
  AddProjectPayload,
  RemoveProjectPayload,
  SetProjectDefaultHarnessPayload,
} from "@station/contracts";

/**
 * DRIVEN PORT
 *
 * Applies project-command values to the authoritative Station configuration
 * and returns the effective configuration.
 */
export interface ProjectConfigWriter {
  addProject(input: AddProjectPayload): Promise<StationConfig>;
  removeProject(input: RemoveProjectPayload): Promise<StationConfig>;
  setDefaultHarness(input: SetProjectDefaultHarnessPayload): Promise<StationConfig>;
}
