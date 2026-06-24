import { stat } from "node:fs/promises";
import type { ProjectConfig } from "../schema.js";
import { findGitRoot } from "./git.js";
import type { ProjectDoctorResult } from "./types.js";

export async function doctorProject(project: ProjectConfig): Promise<ProjectDoctorResult> {
  const messages: string[] = [];
  let rootExists = false;
  try {
    const rootStat = await stat(project.root);
    rootExists = rootStat.isDirectory();
  } catch {
    rootExists = false;
  }

  if (!rootExists) {
    messages.push("Project root is not an existing directory.");
  }

  const gitRoot = rootExists ? await findGitRoot(project.root) : undefined;
  if (gitRoot === undefined) {
    messages.push("Git root was not detected from the project root.");
  }

  return {
    project,
    rootExists,
    ...(gitRoot === undefined ? {} : { gitRoot }),
    status: messages.length === 0 ? "ok" : "warn",
    messages,
  };
}
