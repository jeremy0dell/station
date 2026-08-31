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

/** Renderer-supplied folder-navigation port for the Add Project flow. */
export type TuiFolderService = {
  cwd(): string;
  homeDir(): string;
  readDirectory(path: string): Promise<TuiFolderReadResult>;
  searchDirectories(query: string): Promise<TuiFolderSearchResult>;
  reviewFolder(path: string): Promise<TuiFolderReview>;
  parent(path: string): string;
};
