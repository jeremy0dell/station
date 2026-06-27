export { addProjectToConfig } from "./add.js";
export { doctorProject } from "./doctor.js";
export { findGitRoot, resolveExistingDirectory } from "./git.js";
export { removeProjectFromConfig } from "./remove.js";
export { setProjectDefaultHarnessInConfig } from "./setDefaultHarness.js";
export type {
  AddProjectToConfigOptions,
  AddProjectToConfigResult,
  MinimalProjectBlock,
  ProjectDoctorResult,
  RemoveProjectFromConfigOptions,
  RemoveProjectFromConfigResult,
  SetProjectDefaultHarnessOptions,
  SetProjectDefaultHarnessResult,
} from "./types.js";
