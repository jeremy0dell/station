import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("Homebrew packaging", () => {
  it("keeps the source formula ready for reviewed stable updates", () => {
    const formula = read("packaging/homebrew/station.rb.template");
    const homebrew = read("docs/homebrew.md");
    const checklist = read("docs/public-release-checklist.md");
    const workflow = read(".github/workflows/homebrew-bump.yml");

    expect(formula).toContain('depends_on "git-delta"');
    expect(formula).toContain(
      'assert_equal version.to_s, shell_output("#{bin}/stn --version").strip',
    );
    expect(formula).toContain('assert_match "\\"station-launchers\\"", output');
    expect(formula).not.toContain("cd /path/to/first/git/project");

    expect(workflow).toContain("Validate public stable release");
    expect(workflow).toContain("Homebrew requires a stable release tag");
    expect(workflow).toContain(".immutable");
    expect(workflow).toContain('.visibility)" = public');
    expect(workflow).toContain("gh pr create");
    expect(workflow).toContain("automation/station-");
    expect(workflow).not.toContain("mislav/bump-homebrew-formula-action");
    expect(workflow).not.toContain("push-to:");

    expect(homebrew).toContain("brew install jeremy0dell/station/station");
    const normalizedHomebrew = homebrew.replace(/\s+/gu, " ");
    expect(normalizedHomebrew).toContain("opens or reuses a formula pull request");
    expect(normalizedHomebrew).toContain("contents write and pull-request write");
    expect(checklist).toContain("Artifact signing and provenance");
    expect(checklist).toContain("Final public release candidate");
    expect(checklist).toContain("Stable `v0.7.1`");
  });

  it("renders one exact tag and revision into a valid formula shape", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "station-homebrew-render-"));
    const output = join(temporaryRoot, "Formula", "station.rb");
    const revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try {
      execFileSync(
        process.execPath,
        [
          "scripts/release/render-homebrew-formula.mjs",
          "--template",
          "packaging/homebrew/station.rb.template",
          "--output",
          output,
          "--tag",
          "v9.8.7",
          "--revision",
          revision,
        ],
        { cwd: root, stdio: "pipe" },
      );
      const rendered = readFileSync(output, "utf8");
      expect(rendered.match(/tag:\s+"v9\.8\.7"/gu)).toHaveLength(1);
      expect(rendered.match(/revision: "a{40}"/gu)).toHaveLength(1);

      const ruby = spawnSync("ruby", ["-c", output], { encoding: "utf8" });
      if (ruby.error?.message.includes("ENOENT") !== true) {
        expect(ruby.status, ruby.stderr).toBe(0);
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
