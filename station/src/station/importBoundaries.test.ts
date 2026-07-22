// STATION may use only @station/* packages (via link script), never apps/tui or ink.
// Focusable must be unused (store owns focus).
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const STATION_ROOT = new URL(".", import.meta.url).pathname;
const CONTEXT_MENU_ROOT = new URL("../contextMenu/", import.meta.url).pathname;
const LINKED_STATION_PACKAGES = new Set(["client", "config", "contracts", "dashboard-core", "runtime"]);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}

function importsOf(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  const importPattern = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("station view import boundaries", () => {
  const files = sourceFiles(STATION_ROOT);

  it("finds the station tree", () => {
    const relFiles = new Set(files.map((file) => relative(STATION_ROOT, file)));
    expect(relFiles.has("StationOverlay.tsx")).toBe(true);
    expect(relFiles.has("input/stationOverlayLayer.ts")).toBe(true);
    expect(relFiles.has("view/DashboardView.tsx")).toBe(true);
  });

  it("never imports from apps/tui or ink", () => {
    const failures: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes("apps/tui") || specifier === "ink" || specifier.startsWith("ink/")) {
          failures.push(`${relative(STATION_ROOT, file)} imports ${specifier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("only uses @station packages provided by the link script", () => {
    const failures: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith("@station/")) {
          continue;
        }
        const packageName = specifier.split("/")[1] ?? "";
        if (!LINKED_STATION_PACKAGES.has(packageName)) {
          failures.push(`${relative(STATION_ROOT, file)} imports ${specifier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("does not carry a local ported dashboard fork", () => {
    const failures = files
      .map((file) => relative(STATION_ROOT, file))
      .filter((rel) => rel.startsWith("ported/"));
    expect(failures).toEqual([]);
  });

  it("never sets the focusable prop (the coordination store owns focus)", () => {
    const failures: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".tsx")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      if (/\bfocusable\s*[=:]/.test(source) && !/focusable:\s*false/.test(source)) {
        failures.push(relative(STATION_ROOT, file));
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("context menu import boundaries", () => {
  const files = sourceFiles(CONTEXT_MENU_ROOT);

  it("finds the context menu tree", () => {
    const relFiles = new Set(files.map((file) => relative(CONTEXT_MENU_ROOT, file)));
    expect(relFiles.has("ContextMenuRoot.tsx")).toBe(true);
    expect(relFiles.has("items.ts")).toBe(true);
    expect(relFiles.has("placement.ts")).toBe(true);
  });

  it("never imports from apps/tui, ink, providers, or integrations", () => {
    const failures: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (
          specifier.includes("apps/tui") ||
          specifier === "ink" ||
          specifier.startsWith("ink/") ||
          specifier.includes("/providers/") ||
          specifier.includes("/integrations/") ||
          specifier.startsWith("../../../integrations/")
        ) {
          failures.push(`${relative(CONTEXT_MENU_ROOT, file)} imports ${specifier}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
