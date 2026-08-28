import { normalizeLocalPath, pathIsSame, pathIsSameOrInside } from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("local path identity", () => {
  it("applies only authorized aliases and preserves ordinary input shaping", () => {
    expect([
      pathIsSame("/tmp/root", "/private/tmp/root", "darwin"),
      pathIsSame("/tmp/root", "/private/tmp/root", "linux"),
      pathIsSame("/var/folders/task", "/private/var/folders/task", "linux"),
      normalizeLocalPath("/private/tmp-sibling/root", "darwin"),
      pathIsSameOrInside("/private/tmp/root/task", "/tmp/root", "darwin"),
      normalizeLocalPath("/home/station/task/", "linux"),
      normalizeLocalPath(" /home/station/task\t", "linux"),
    ]).toEqual([
      true,
      false,
      true,
      "/private/tmp-sibling/root",
      true,
      "/home/station/task",
      "/home/station/task",
    ]);
  });

  it("rejects same- and cross-spelling dot segments before comparison", () => {
    const physicalDotted = "/private/tmp/root/../escape";
    expect(normalizeLocalPath(physicalDotted, "darwin")).toBe(physicalDotted);
    for (const [candidate, root] of [
      [physicalDotted, "/private/tmp/escape"],
      ["/tmp/root/../escape", "/private/tmp/root"],
      ["/private/tmp/root", "/tmp/root/../escape"],
      ["/tmp/root/./task", "/tmp/root/task"],
      ["/tmp/root/./task", "/private/tmp/root/task"],
      ["/private/tmp/root/task", "/tmp/root/./task"],
    ]) {
      expect(pathIsSame(candidate, root, "darwin")).toBe(false);
      expect(pathIsSameOrInside(candidate, root, "darwin")).toBe(false);
    }
  });

  it("keeps observed POSIX whitespace siblings distinct", () => {
    for (const suffix of [" ", "\t", "\n"]) {
      expect(pathIsSame(`/tmp/root${suffix}`, "/tmp/root", "darwin")).toBe(false);
      expect(pathIsSameOrInside(`/tmp/root${suffix}`, "/tmp/root", "darwin")).toBe(false);
    }
  });
});
