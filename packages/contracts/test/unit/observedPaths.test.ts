import {
  applyObservedPathAliases,
  normalizeObservedPath,
  observedPathIsSameOrInside,
  sameObservedPath,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

describe("observed path identity", () => {
  it("applies Darwin temporary aliases without weakening component boundaries", () => {
    expect([
      sameObservedPath("/tmp", "/private/tmp", "darwin"),
      sameObservedPath("/tmp/root/task", "/private/tmp/root/task", "darwin"),
      sameObservedPath("/tmp/root/task", "/private/tmp/root/task", "linux"),
      normalizeObservedPath("/private/tmp-sibling/task", "darwin"),
      observedPathIsSameOrInside("/private/tmp/root/task", "/tmp/root", "darwin"),
      observedPathIsSameOrInside("/private/tmp/root-sibling/task", "/tmp/root", "darwin"),
      observedPathIsSameOrInside("/private/tmp-sibling/root/task", "/tmp/root", "darwin"),
      observedPathIsSameOrInside("private/tmp/root/task", "/tmp/root", "darwin"),
    ]).toEqual([true, true, false, "/private/tmp-sibling/task", true, false, false, false]);
  });

  it("rejects same- and cross-spelling dot segments before comparison", () => {
    expect(applyObservedPathAliases("/private/tmp/root/../escape", "darwin")).toBe(
      "/private/tmp/root/../escape",
    );
    expect(normalizeObservedPath("/private/tmp/root/../escape", "darwin")).toBe("/tmp/escape");
    for (const [candidate, root] of [
      ["/tmp/root/../escape", "/tmp/escape"],
      ["/tmp/root/../escape", "/private/tmp/root"],
      ["/private/tmp/root", "/tmp/root/../escape"],
      ["/tmp/root/./task", "/tmp/root/task"],
      ["/tmp/root/./task", "/private/tmp/root/task"],
      ["/private/tmp/root/task", "/tmp/root/./task"],
    ]) {
      expect(sameObservedPath(candidate, root, "darwin")).toBe(false);
      expect(observedPathIsSameOrInside(candidate, root, "darwin")).toBe(false);
    }
  });

  it("preserves POSIX whitespace as observed identity", () => {
    for (const suffix of [" ", "\t", "\n"]) {
      const path = `/private/tmp/root/feature${suffix}`;
      expect(normalizeObservedPath(path, "darwin")).toBe(`/tmp/root/feature${suffix}`);
      expect(sameObservedPath(path, "/tmp/root/feature", "darwin")).toBe(false);
    }
  });

  it("preserves /private/var identity and ordinary paths on every platform", () => {
    const platforms = ["darwin", "linux"] satisfies NodeJS.Platform[];
    expect(platforms.map((p) => sameObservedPath("/var/task", "/private/var/task", p))).toEqual([
      true,
      true,
    ]);
    expect(platforms.map((p) => normalizeObservedPath("/home/task", p))).toEqual([
      "/home/task",
      "/home/task",
    ]);
  });
});
