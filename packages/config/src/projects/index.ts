export { addProjectToConfig } from "./add.js";
export { doctorProject } from "./doctor.js";
export { findGitRoot, resolveExistingDirectory } from "./git.js";
export { removeProjectFromConfig } from "./remove.js";
export type {
  AddProjectToConfigOptions,
  AddProjectToConfigResult,
  MinimalProjectBlock,
  ProjectDoctorResult,
  RemoveProjectFromConfigOptions,
  RemoveProjectFromConfigResult,
} from "./types.js";
