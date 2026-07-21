import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

describe("public installer release", () => {
  it("publishes a version-stamped installer and preserves authenticated draft acceptance", () => {
    const installer = read("scripts/install.sh");
    const release = read(".github/workflows/release.yml");

    expect(installer).toContain('embedded_version=""');
    expect(installer).toContain("run_curl");
    expect(installer).toContain("https://github.com/$repository/releases/download/$tag");
    expect(installer).toContain("STATION_INSTALL_RELEASE_ID");

    expect(release).toContain("render-release-installer.mjs");
    expect(release).toContain('"install.sh"');
    expect(release).toContain("release/install.sh");
    expect(release).toContain("STATION_INSTALL_RELEASE_ID");
  });

  it("runs an unauthenticated public install after immutable promotion", () => {
    const promote = read(".github/workflows/promote-release.yml");

    expect(promote).toContain("verify-public-install");
    expect(promote).toContain("releases/download/$TAG/install.sh");
    expect(promote).toContain("releases/latest/download/install.sh");
    expect(promote).toContain("env -u GH_TOKEN");
  });
});
