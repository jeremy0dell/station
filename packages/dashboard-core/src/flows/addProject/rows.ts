import type { AddProjectChooseState } from "./types.js";

export type AddProjectFolderRow =
  | {
      kind: "current";
      name: ".";
      path: string;
    }
  | {
      kind: "directory";
      name: string;
      path: string;
      displayPath?: string;
    }
  | {
      kind: "search";
      name: string;
      path: string;
      displayPath?: string;
    };

export function addProjectRows(state: AddProjectChooseState): AddProjectFolderRow[] {
  const rows: AddProjectFolderRow[] = [
    {
      kind: "current",
      name: ".",
      path: state.currentPath,
    },
    ...state.entries.map((entry) => ({
      kind: "directory" as const,
      name: entry.name,
      path: entry.path,
      ...(entry.displayPath === undefined ? {} : { displayPath: entry.displayPath }),
    })),
  ];
  if (state.filter.length === 0) {
    return rows;
  }
  const filter = state.filter.toLowerCase();
  const localRows = rows.filter(
    (row) => row.name.toLowerCase().includes(filter) || row.path.toLowerCase().includes(filter),
  );
  const seenPaths = new Set(localRows.map((row) => row.path));
  const searchRows = state.searchEntries
    .filter((entry) => !seenPaths.has(entry.path))
    .map((entry) => ({
      kind: "search" as const,
      name: entry.name,
      path: entry.path,
      ...(entry.displayPath === undefined ? {} : { displayPath: entry.displayPath }),
    }));
  return [...localRows, ...searchRows];
}
