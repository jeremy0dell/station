import { describe, expect, it } from "vitest";
import {
  parseObserverProcessArgs,
  resolveObserverSocketForProcessArgs,
} from "../../src/observerProcessArgs.js";

const HOME = "/home/u";

function resolve(argv: string[], files: Record<string, string> = {}, xdg = "") {
  // Pin XDG explicitly so a real XDG_RUNTIME_DIR in CI cannot leak into the
  // non-XDG cases (empty string = no XDG override).
  return resolveObserverSocketForProcessArgs(argv, {
    homeDir: HOME,
    xdgRuntimeDir: xdg,
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
  });
}

describe("parseObserverProcessArgs", () => {
  it("extracts --config, --socket, --state-dir and ignores unrelated flags", () => {
    expect(
      parseObserverProcessArgs(["--config", "/c.toml", "--x", "y", "--state-dir", "/s"]),
    ).toEqual({ configPath: "/c.toml", stateDir: "/s" });
  });

  it("ignores a trailing flag with no value", () => {
    expect(parseObserverProcessArgs(["--socket"])).toEqual({});
  });
});

describe("resolveObserverSocketForProcessArgs", () => {
  it("prefers an explicit --socket over everything (no config read)", () => {
    expect(resolve(["--socket", "/run/x.sock", "--config", "/missing.toml"])).toBe("/run/x.sock");
  });

  it("uses config [observer].socket_path when no --socket", () => {
    expect(
      resolve(["--config", "/c.toml"], { "/c.toml": '[observer]\nsocket_path = "/v/o.sock"\n' }),
    ).toBe("/v/o.sock");
  });

  it("falls back to <state_dir>/run/observer.sock from config when no socket_path and no XDG", () => {
    expect(
      resolve(["--config", "/c.toml"], { "/c.toml": '[observer]\nstate_dir = "/data/st"\n' }),
    ).toBe("/data/st/run/observer.sock");
  });

  it("lets --state-dir override the config state_dir", () => {
    expect(
      resolve(["--config", "/c.toml", "--state-dir", "/override"], {
        "/c.toml": '[observer]\nstate_dir = "/data/st"\n',
      }),
    ).toBe("/override/run/observer.sock");
  });

  it("uses XDG runtime dir when set and no socket override", () => {
    expect(resolve(["--state-dir", "/data/st"], {}, "/xdg")).toBe("/xdg/station/observer.sock");
  });

  it("expands ~ against the injected home dir", () => {
    expect(
      resolve(["--config", "/c.toml"], { "/c.toml": '[observer]\nstate_dir = "~/.state"\n' }),
    ).toBe(`${HOME}/.state/run/observer.sock`);
  });

  it("defaults to ~/.local/state/station/run when no config, socket, or state dir", () => {
    expect(resolve([])).toBe(`${HOME}/.local/state/station/run/observer.sock`);
  });

  it("fail-closes to undefined when the config file cannot be read", () => {
    expect(resolve(["--config", "/gone.toml"])).toBeUndefined();
  });

  it("treats a config with no [observer] section as defaults, not a failure", () => {
    expect(resolve(["--config", "/c.toml"], { "/c.toml": "schema_version = 1\n" })).toBe(
      `${HOME}/.local/state/station/run/observer.sock`,
    );
  });

  it("fail-closes on unparseable TOML rather than guessing", () => {
    expect(resolve(["--config", "/c.toml"], { "/c.toml": "this is = = not toml" })).toBeUndefined();
  });
});
