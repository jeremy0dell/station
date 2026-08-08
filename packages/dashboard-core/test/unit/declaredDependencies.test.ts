import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE_BUILTIN_PREFIX = "node:";

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith(NODE_BUILTIN_PREFIX)) return undefined;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function collectSourceImports(directory: string, found: Map<string, string[]>): void {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      collectSourceImports(full, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(full, "utf8");
    for (const match of text.matchAll(/from\s*"([^"]+)"/g)) {
      const name = packageNameOf(match[1]);
      if (name === undefined) continue;
      const list = found.get(name) ?? [];
      list.push(full.slice(PACKAGE_ROOT.length + 1));
      found.set(name, list);
    }
  }
}

describe("dashboard-core declared dependencies", () => {
  it("imports only declared production dependencies from src", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const imports = new Map<string, string[]>();
    collectSourceImports(join(PACKAGE_ROOT, "src"), imports);

    const undeclared = [...imports.entries()]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} <- ${files.join(", ")}`);

    // Emitted declarations re-export src type imports, so an undeclared src
    // dependency becomes an undeclared production type dependency for consumers.
    expect(undeclared).toEqual([]);
  });
});
