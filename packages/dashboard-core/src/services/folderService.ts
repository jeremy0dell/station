import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type TuiFolderEntry = {
  name: string;
  path: string;
  kind: "directory";
  displayPath?: string;
};

export type TuiFolderReadResult = {
  path: string;
  entries: TuiFolderEntry[];
};

export type TuiFolderReview = {
  selectedPath: string;
  gitRoot?: string;
  id: string;
  label: string;
};

export type TuiFolderSearchResult = {
  query: string;
  entries: TuiFolderEntry[];
  truncated: boolean;
};

export type TuiFolderService = {
  cwd(): string;
  homeDir(): string;
  readDirectory(path: string): Promise<TuiFolderReadResult>;
  searchDirectories(query: string): Promise<TuiFolderSearchResult>;
  reviewFolder(path: string): Promise<TuiFolderReview>;
  parent(path: string): string;
};

const SEARCH_MAX_DEPTH = 5;
const SEARCH_MAX_VISITED = 1_200;
const SEARCH_MAX_RESULTS = 80;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".Trash",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Applications",
  "node_modules",
]);

export function createNodeFolderService(): TuiFolderService {
  const cache = new Map<string, TuiFolderReadResult>();
  const home = homedir();
  return {
    cwd: () => process.cwd(),
    homeDir: () => home,
    readDirectory: async (path) => {
      const resolvedPath = resolvePath(path, home);
      const cached = cache.get(resolvedPath);
      if (cached !== undefined) {
        return cached;
      }
      const entries = await visibleDirectoryEntries(resolvedPath);
      const result: TuiFolderReadResult = {
        path: resolvedPath,
        entries: entries
          .map((entry) => ({
            name: entry.name,
            path: join(resolvedPath, entry.name),
            kind: "directory" as const,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      };
      cache.set(resolvedPath, result);
      if (cache.size > 50) {
        cache.delete(cache.keys().next().value as string);
      }
      return result;
    },
    searchDirectories: async (query) => searchDirectories(query, { cwd: process.cwd(), home }),
    reviewFolder: async (path) => {
      const selectedPath = resolvePath(path, home);
      const gitRoot = await findGitRoot(selectedPath);
      const root = gitRoot ?? selectedPath;
      const label = labelFromPath(root);
      return {
        selectedPath,
        ...(gitRoot === undefined ? {} : { gitRoot }),
        id: projectIdFromLabel(label),
        label,
      };
    },
    parent: (path) => dirname(resolvePath(path, home)),
  };
}

async function searchDirectories(
  query: string,
  input: { cwd: string; home: string },
): Promise<TuiFolderSearchResult> {
  const normalizedQuery = query.trim();
  if (!shouldSearch(normalizedQuery)) {
    return { query: normalizedQuery, entries: [], truncated: false };
  }

  const roots = searchRoots(input).map((root) => resolvePath(root, input.home));
  const seenRoots = uniquePaths(roots);
  const matches: TuiFolderEntry[] = [];
  const visited = new Set<string>();
  let truncated = false;
  let reachedVisitLimit = false;

  for (const root of seenRoots) {
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    while (queue.length > 0) {
      if (matches.length >= SEARCH_MAX_RESULTS) {
        truncated = true;
        break;
      }
      if (visited.size >= SEARCH_MAX_VISITED) {
        reachedVisitLimit = true;
        break;
      }
      const next = queue.shift();
      if (next === undefined || visited.has(next.path)) {
        continue;
      }
      visited.add(next.path);
      const name = basename(next.path);
      if (directoryMatches(next.path, normalizedQuery, input.home)) {
        matches.push({
          name,
          path: next.path,
          displayPath: displayPath(next.path, input.home),
          kind: "directory",
        });
      }
      if (next.depth >= SEARCH_MAX_DEPTH) {
        continue;
      }
      for (const entry of await safeVisibleDirectoryEntries(next.path)) {
        queue.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
      }
    }
    if (truncated || reachedVisitLimit) {
      break;
    }
  }

  return {
    query: normalizedQuery,
    entries: sortSearchResults(matches, normalizedQuery, input.home),
    truncated,
  };
}

function searchRoots(input: { cwd: string; home: string }): string[] {
  return [
    `${input.home}/Desktop/projects`,
    `${input.home}/Developer`,
    `${input.home}/src`,
    `${input.home}/code`,
    dirname(resolve(input.cwd)),
  ];
}

async function visibleDirectoryEntries(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !IGNORED_DIRECTORY_NAMES.has(entry.name));
}

async function safeVisibleDirectoryEntries(path: string) {
  try {
    return await visibleDirectoryEntries(path);
  } catch {
    return [];
  }
}

async function findGitRoot(startPath: string): Promise<string | undefined> {
  let current = resolve(startPath);
  for (;;) {
    if (await hasGitMarker(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    const marker = await stat(join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

function resolvePath(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return resolve(home, path.slice(2));
  }
  return resolve(path);
}

function shouldSearch(query: string): boolean {
  return query.length >= 2 && !isPathLike(query);
}

function isPathLike(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("/");
}

function directoryMatches(path: string, query: string, home: string): boolean {
  const loweredQuery = query.toLowerCase();
  const name = basename(path).toLowerCase();
  if (name.includes(loweredQuery)) {
    return true;
  }
  if (!loweredQuery.includes("/")) {
    return false;
  }
  return displayPath(path, home).toLowerCase().includes(loweredQuery);
}

function sortSearchResults(
  entries: readonly TuiFolderEntry[],
  query: string,
  home: string,
): TuiFolderEntry[] {
  const lowered = query.toLowerCase();
  return [...entries].sort((left, right) => {
    const leftRank = searchRank(left, lowered, home);
    const rightRank = searchRank(right, lowered, home);
    return leftRank - rightRank || left.displayPath?.localeCompare(right.displayPath ?? "") || 0;
  });
}

function searchRank(entry: TuiFolderEntry, query: string, home: string): number {
  const name = entry.name.toLowerCase();
  const path = displayPath(entry.path, home).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (path.includes(`${sep}${query}`)) return 2;
  return 3;
}

function displayPath(path: string, home: string): string {
  const relativePath = relative(home, path);
  if (!relativePath.startsWith("..") && relativePath !== "") {
    return `~/${relativePath}`;
  }
  return path;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const resolvedPath = resolve(path);
    if (!seen.has(resolvedPath)) {
      seen.add(resolvedPath);
      result.push(resolvedPath);
    }
  }
  return result;
}

function labelFromPath(path: string): string {
  const label = path.split("/").filter(Boolean).at(-1);
  return label === undefined || label.length === 0 ? "project" : label;
}

function projectIdFromLabel(label: string): string {
  const id = label
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return id.length === 0 ? "project" : id;
}
