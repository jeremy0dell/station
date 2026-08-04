import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);

describe("TypeScript toolchain", () => {
  it("keeps native TypeScript 7 on the CLI and TypeScript 6 behind the compiler API", () => {
    const nativePackage = require("@typescript/native/package.json") as { version: string };
    const compatibilityPackage = require("typescript/package.json") as { version: string };
    const nativeTsc = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));
    const compiler = spawnSync(nativeTsc, ["--version"], { encoding: "utf8" });

    expect(compiler.status).toBe(0);
    expect(compiler.stdout.trim()).toBe("Version 7.0.2");
    expect(nativePackage.version).toBe("7.0.2");
    expect(compatibilityPackage.version).toBe("6.0.2");
    expect(ts.version).toBe("6.0.3");
  });
});
