import type { TuiFolderService } from "@station/dashboard-core/runtime";

/** Filesystem-free folder navigation for Station composition tests. */
export function createFakeFolderService(): TuiFolderService {
  return {
    cwd: () => "/Users/example/Developer/station",
    homeDir: () => "/Users/example",
    parent: (path) => path.split("/").slice(0, -1).join("/") || "/",
    readDirectory: async (path) => ({ path, entries: [] }),
    searchDirectories: async (query) => ({ query, entries: [], truncated: false }),
    reviewFolder: async (path) => ({
      selectedPath: path,
      gitRoot: path,
      id: "station",
      label: "station",
    }),
  };
}
