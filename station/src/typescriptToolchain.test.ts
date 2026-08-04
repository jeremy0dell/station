import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

const require = createRequire(import.meta.url);

describe("TypeScript toolchain", () => {
  it("exposes native TypeScript 7 to tools and isolates the TypeScript 6 compiler API", () => {
    const nativeAliasPackage = require("@typescript/native/package.json") as { version: string };
    const nativePackage = require("typescript/package.json") as { version: string };
    const compatibilityPackage = require("@typescript/typescript6/package.json") as {
      version: string;
    };
    const binDirectory = fileURLToPath(new URL("../node_modules/.bin/", import.meta.url));
    const compiler = spawnSync(join(binDirectory, "tsc"), ["--version"], { encoding: "utf8" });

    expect(compiler.status).toBe(0);
    expect(compiler.stdout.trim()).toBe("Version 7.0.2");
    expect(nativeAliasPackage.version).toBe("7.0.2");
    expect(nativePackage.version).toBe("7.0.2");
    expect(compatibilityPackage.version).toBe("6.0.2");
    expect(ts.version).toBe("6.0.3");
  });
});
