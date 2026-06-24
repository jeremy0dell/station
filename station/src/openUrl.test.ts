import { describe, expect, it } from "bun:test";
import { resolveOpenUrlCommand } from "./openUrl.js";

describe("resolveOpenUrlCommand", () => {
  it("maps http(s) URLs to the platform opener", () => {
    expect(resolveOpenUrlCommand("darwin", "https://github.com/example/station/pull/12")).toEqual({
      command: "open",
      args: ["https://github.com/example/station/pull/12"],
    });
    expect(resolveOpenUrlCommand("linux", "http://example.com")).toEqual({
      command: "xdg-open",
      args: ["http://example.com/"],
    });
  });

  it("opens Windows URLs via rundll32, not cmd (no shell-operator re-parsing)", () => {
    expect(resolveOpenUrlCommand("win32", "https://example.com/?a=b&c=d")).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", "https://example.com/?a=b&c=d"],
    });
  });

  it("rejects non-http(s) protocols and unparseable URLs", () => {
    expect(resolveOpenUrlCommand("darwin", "file:///etc/passwd")).toBeUndefined();
    expect(resolveOpenUrlCommand("darwin", "javascript:alert(1)")).toBeUndefined();
    expect(resolveOpenUrlCommand("darwin", "vscode://x")).toBeUndefined();
    expect(resolveOpenUrlCommand("darwin", "not a url")).toBeUndefined();
  });

  it("returns undefined for platforms with no known opener", () => {
    expect(resolveOpenUrlCommand("aix", "https://example.com")).toBeUndefined();
  });
});
