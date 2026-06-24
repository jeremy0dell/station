import { basename, parse, resolve } from "node:path";
import type { ProjectConfig } from "../schema.js";
import type { MinimalProjectBlock } from "./types.js";

export function uniqueProjectId(requestedId: string, projects: readonly ProjectConfig[]): string {
  const base = normalizeProjectId(requestedId);
  const used = new Set(projects.map((project) => project.id));
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

export function projectIdFromRoot(root: string): string {
  return normalizeProjectId(labelFromRoot(root));
}

export function labelFromRoot(root: string): string {
  const parsed = parse(root);
  return basename(root) || parsed.name || "project";
}

export function minimalBlockFromProject(project: ProjectConfig): MinimalProjectBlock {
  return {
    id: project.id,
    label: project.label,
    root: project.root,
  };
}

export function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function normalizeProjectId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return normalized.length === 0 ? "project" : normalized;
}
