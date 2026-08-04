import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("no-one-to-one-aliases Biome plugin", () => {
  it("rejects named aliases while allowing constructed types and namespace imports", async () => {
    const invalid = await lintFixture(`
      type Alias = Canonical;
      type QualifiedAlias = protocol.Canonical;
      import { canonical as local, untouched } from "./values.js";
      import type { Canonical as LocalCanonical, Other } from "./types.js";
      export { canonical as publicName, untouched };
      export type { Canonical as PublicCanonical, Other };
      export { canonical as reexported } from "./values.js";
      export type { Canonical as ReexportedCanonical } from "./types.js";
    `);

    expect(invalid.status).toBe(1);
    expect(
      invalid.output.match(/Use the canonical symbol name instead of a one-to-one alias\./g),
    ).toHaveLength(8);

    const valid = await lintFixture(`
      type PaneId = string;
      type Selected = Pick<Canonical, "id">;
      type Result = Success | Failure;
      import { canonical } from "./values.js";
      import * as values from "./values.js";
      export { canonical };
      // biome-ignore lint/plugin: retained compatibility boundary
      export type CompatibilityName = Canonical;
      void values;
    `);

    expect(valid.status).toBe(0);
  });
});

async function lintFixture(source: string): Promise<{ status: number | null; output: string }> {
  const root = await mkdtemp(join(tmpdir(), "station-no-one-to-one-aliases-"));
  roots.push(root);
  const pluginPath = join(root, "no-one-to-one-aliases.grit");
  const configPath = join(root, "biome.json");
  const fixturePath = join(root, "fixture.ts");
  await Promise.all([
    copyFile(resolve("tools/lint/no-one-to-one-aliases.grit"), pluginPath),
    writeFile(
      configPath,
      JSON.stringify({
        files: { ignoreUnknown: true },
        formatter: { enabled: false },
        assist: { enabled: false },
        plugins: ["./no-one-to-one-aliases.grit"],
        linter: { enabled: true, rules: { recommended: false } },
      }),
    ),
    writeFile(fixturePath, source),
  ]);
  const result = spawnSync(
    resolve("node_modules/.bin/biome"),
    ["lint", "--config-path", configPath, "--max-diagnostics=none", fixturePath],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
