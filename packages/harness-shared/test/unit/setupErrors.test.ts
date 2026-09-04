import { describe, expect, it } from "vitest";
import { hookSetupErrorClass, isHookOwnershipConflict } from "../../src/hooks/setupErrors";

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
