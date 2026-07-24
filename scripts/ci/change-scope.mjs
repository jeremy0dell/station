export const DOCUMENTATION_ONLY_SCOPE = "documentation-only";
export const FULL_SCOPE = "full";

export function isDocumentationPath(filePath) {
  return filePath.startsWith("docs/") || filePath.endsWith(".md") || filePath.endsWith(".mdx");
}

export function classifyChangedPaths(filePaths) {
  const paths = [...new Set(filePaths)];
  if (paths.length === 0) return FULL_SCOPE;
  return paths.every(isDocumentationPath) ? DOCUMENTATION_ONLY_SCOPE : FULL_SCOPE;
}
