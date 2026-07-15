import type { LoadedStationConfig } from "../load/index.js";
import type { ProjectConfig, StationConfig } from "../schema.js";

export type MinimalProjectBlock = {
  id: string;
  label: string;
  root: string;
  defaultBranch?: string;
  worktrunkBase?: string;
};

export type AddProjectToConfigOptions = {
  path: string;
  configPath?: string;
  homeDir?: string;
  id?: string;
  label?: string;
  allowNonGit?: boolean;
};

export type AddProjectToConfigResult = {
  status: "added" | "unchanged";
  configPath: string;
  selectedPath: string;
  gitRoot?: string;
  project: ProjectConfig;
  writtenBlock: MinimalProjectBlock;
  config: StationConfig;
};

export type RemoveProjectFromConfigOptions = {
  projectId: string;
  configPath?: string;
  homeDir?: string;
};

export type RemoveProjectFromConfigResult = {
  status: "removed";
  configPath: string;
  projectId: string;
  removedProject: ProjectConfig;
  config: StationConfig;
};

export type SetProjectDefaultHarnessOptions = {
  projectId: string;
  harness: string;
  configPath?: string;
  homeDir?: string;
};

export type SetProjectDefaultHarnessResult = {
  status: "updated" | "unchanged";
  configPath: string;
  projectId: string;
  harness: string;
  config: StationConfig;
};

export type ProjectDoctorResult = {
  project: ProjectConfig;
  rootExists: boolean;
  gitRoot?: string;
  status: "ok" | "warn";
  messages: string[];
};

export type LoadedConfigSource = {
  configPath: string;
  homeDir: string;
  source: string;
  loaded: LoadedStationConfig;
};
