import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hookSetupErrorClass,
  hookSetupFileOpsFor,
  isHookOwnershipConflict,
} from "../../src/hooks/setupErrors";

type DemoCode = "DEMO_HOOK_CONFIG_UNREADABLE" | "DEMO_HOOK_WRITE_FAILED";

const DemoHookSetupError = hookSetupErrorClass<DemoCode>({
  tag: "DemoHookSetupError",
  provider: "demo",
});

const owner = { launcher: "/opt/station/bin/stn", resolved: "/opt/station/bin/stn" };

describe("hookSetupErrorClass", () => {
  it("carries the tag, provider, and code without prefixing the message", () => {
    const error = new DemoHookSetupError(
      "DEMO_HOOK_WRITE_FAILED",
      "Demo hook config write failed.",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.tag).toBe("DemoHookSetupError");
    expect(error.provider).toBe("demo");
    expect(error.code).toBe("DEMO_HOOK_WRITE_FAILED");
    expect(error.message).toBe("Demo hook config write failed.");
    expect(error.name).toBe("DemoHookSetupError");
    expect(Object.keys(error)).not.toContain("name");
  });
});

describe("hookSetupFileOpsFor", () => {
  const removeFailureFor = async (removeTarget: "file" | "script") => {
    const ops = hookSetupFileOpsFor(
      DemoHookSetupError,
      { unreadable: "DEMO_HOOK_CONFIG_UNREADABLE", writeFailed: "DEMO_HOOK_WRITE_FAILED" },
      { displayName: "Demo", removeTarget },
    );
    const root = await mkdtemp(join(tmpdir(), "station-demo-hook-ops-"));
    const target = join(root, "artifact");
    await writeFile(target, "generated", "utf8");
    // Read-only parent: the artifact exists, but unlink fails at the remove step.
    await chmod(root, 0o500);
    try {
      return await ops.removeHookFileIfPresent(target).then(
        () => undefined,
        (cause: unknown) => cause,
      );
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  };

  it("names the removed artifact by the provider own wording", async () => {
    expect(await removeFailureFor("file")).toMatchObject({
      code: "DEMO_HOOK_WRITE_FAILED",
      message: "Demo hook file could not be removed.",
    });
    expect(await removeFailureFor("script")).toMatchObject({
      code: "DEMO_HOOK_WRITE_FAILED",
      message: "Demo hook script could not be removed.",
    });
  });
});

describe("isHookOwnershipConflict", () => {
  it("treats a different or unreadable owner as a conflict", () => {
    expect(isHookOwnershipConflict({ status: "different-owner", currentLauncher: "/other" })).toBe(
      true,
    );
    expect(isHookOwnershipConflict({ status: "unknown-owner" })).toBe(true);
    expect(
      isHookOwnershipConflict({ status: "same-owner", requested: owner, currentLauncher: "/opt" }),
    ).toBe(false);
    expect(isHookOwnershipConflict(undefined)).toBe(false);
  });
});
