import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStationLinkOwnership,
  mutateStationLinkRegistry,
  resolveBunGlobalLocations,
  stationLinkRegistryLockPaths,
  withStationLinkRegistryLocks,
} from "../../scripts/station-link-registry.mjs";

const requiredExactBun = "1.4.0";

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`);
  chmodSync(path, 0o755);
}

function findExactBun(): string | undefined {
  const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== requiredExactBun) return undefined;
  const executable = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
    encoding: "utf8",
  });
  return executable.status === 0 ? realpathSync(executable.stdout.trim()) : undefined;
}

describe("Station link registry", () => {
  it("refuses to unlink a registration or launcher claimed by another checkout", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-link-ownership-"));
    try {
      const checkoutA = join(fixture, "checkout-a");
      const checkoutB = join(fixture, "checkout-b");
      const locations = {
        globalBinDir: join(fixture, "global-bin"),
        globalDir: join(fixture, "global-packages"),
      };
      const launchers = {
        stn: join("bin", "stn"),
        "stn-ingress": join("bin", "stn-ingress"),
        "stn-tmux-popup": join("integrations", "terminal", "tmux", "bin", "stn-popup"),
      };
      mkdirSync(locations.globalBinDir, { recursive: true });
      mkdirSync(join(locations.globalDir, "node_modules"), { recursive: true });
      for (const checkout of [checkoutA, checkoutB]) {
        mkdirSync(checkout, { recursive: true });
        writeFileSync(join(checkout, "package.json"), '{"name":"station"}\n');
        for (const target of Object.values(launchers)) {
          const path = join(checkout, target);
          mkdirSync(join(path, ".."), { recursive: true });
          writeExecutable(path, "exit 0\n");
        }
      }
      const registration = join(locations.globalDir, "node_modules", "station");
      symlinkSync(checkoutA, registration);
      for (const [launcher, target] of Object.entries(launchers)) {
        symlinkSync(join(checkoutA, target), join(locations.globalBinDir, launcher));
      }

      await expect(assertStationLinkOwnership(checkoutA, locations)).resolves.toBeUndefined();

      rmSync(join(locations.globalBinDir, "stn"));
      symlinkSync(join(checkoutB, launchers.stn), join(locations.globalBinDir, "stn"));
      await expect(assertStationLinkOwnership(checkoutA, locations)).rejects.toThrow(
        "global launcher stn belongs to another checkout",
      );

      rmSync(join(locations.globalBinDir, "stn"));
      symlinkSync(join(checkoutA, launchers.stn), join(locations.globalBinDir, "stn"));
      rmSync(registration);
      symlinkSync(checkoutB, registration);
      await expect(assertStationLinkOwnership(checkoutA, locations)).rejects.toThrow(
        "global registration station belongs to another checkout",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("resolves Bun's merged global registry paths and their distinct path semantics", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-bunfig-global-bin-"));
    try {
      const home = join(fixture, "home");
      const xdgConfig = join(fixture, "xdg-config");
      const xdgCache = join(fixture, "xdg-cache");
      const checkout = join(fixture, "checkout");
      mkdirSync(home, { recursive: true });
      mkdirSync(xdgConfig, { recursive: true });
      mkdirSync(checkout, { recursive: true });
      writeFileSync(
        join(home, ".bunfig.toml"),
        '[install]\nglobalBinDir = "/ignored/home-bin"\nglobalDir = "/ignored/home-global"\n',
      );
      writeFileSync(
        join(xdgConfig, ".bunfig.toml"),
        '[install]\nglobalBinDir = "~/.local/bun-bin"\nglobalDir = "~/.local/bun-global"\n',
      );

      const options = { workingDirectory: checkout };
      await expect(
        resolveBunGlobalLocations(
          {
            HOME: home,
            XDG_CONFIG_HOME: xdgConfig,
            XDG_CACHE_HOME: xdgCache,
          },
          options,
        ),
      ).resolves.toEqual({
        globalBinDir: join(checkout, "~/.local/bun-bin"),
        globalDir: join(checkout, "~/.local/bun-global"),
      });
      await expect(
        resolveBunGlobalLocations(
          {
            BUN_INSTALL_BIN: "~/literal-bin",
            BUN_INSTALL_GLOBAL_DIR: "relative/global",
            HOME: home,
            XDG_CONFIG_HOME: xdgConfig,
          },
          options,
        ),
      ).resolves.toEqual({
        globalBinDir: join(checkout, "~", "literal-bin"),
        globalDir: join(checkout, "relative/global"),
      });

      writeFileSync(join(checkout, "bunfig.toml"), '[install]\nauto = "disable"\n');
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CONFIG_HOME: xdgConfig }, options),
      ).resolves.toEqual({
        globalBinDir: join(checkout, "~/.local/bun-bin"),
        globalDir: join(checkout, "~/.local/bun-global"),
      });

      writeFileSync(join(checkout, "bunfig.toml"), '[install]\nglobalBinDir = "./checkout-bin"\n');
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CONFIG_HOME: xdgConfig }, options),
      ).resolves.toEqual({
        globalBinDir: join(checkout, "checkout-bin"),
        globalDir: join(checkout, "~/.local/bun-global"),
      });

      writeFileSync(
        join(checkout, "bunfig.toml"),
        '[install]\nglobalBinDir = ""\nglobalDir = ""\n',
      );
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CONFIG_HOME: xdgConfig }, options),
      ).resolves.toEqual({
        globalBinDir: join(home, ".bun/bin"),
        globalDir: join(home, ".bun/install/global"),
      });
      await expect(
        resolveBunGlobalLocations(
          {
            BUN_INSTALL: "/custom/bun",
            HOME: home,
            XDG_CONFIG_HOME: xdgConfig,
            XDG_CACHE_HOME: xdgCache,
          },
          options,
        ),
      ).resolves.toEqual({
        globalBinDir: "/custom/bun/bin",
        globalDir: "/custom/bun/install/global",
      });

      rmSync(join(checkout, "bunfig.toml"));
      await expect(resolveBunGlobalLocations({ HOME: home }, options)).resolves.toEqual({
        globalBinDir: "/ignored/home-bin",
        globalDir: "/ignored/home-global",
      });
      rmSync(join(xdgConfig, ".bunfig.toml"));
      await expect(
        resolveBunGlobalLocations(
          {
            HOME: home,
            XDG_CONFIG_HOME: xdgConfig,
            XDG_CACHE_HOME: xdgCache,
          },
          options,
        ),
      ).resolves.toEqual({
        globalBinDir: join(xdgCache, ".bun/bin"),
        globalDir: join(xdgCache, ".bun/install/global"),
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed or unsafe Bun global-bin configuration", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-bunfig-global-bin-invalid-"));
    try {
      const home = join(fixture, "home");
      const xdgConfig = join(fixture, "xdg-config");
      const checkout = join(fixture, "checkout");
      mkdirSync(home, { recursive: true });
      mkdirSync(xdgConfig, { recursive: true });
      mkdirSync(checkout, { recursive: true });
      const options = { workingDirectory: checkout };

      await expect(resolveBunGlobalLocations({}, options)).rejects.toThrow(
        "Bun global registry defaults require BUN_INSTALL, XDG_CACHE_HOME, or HOME",
      );
      await expect(
        resolveBunGlobalLocations(
          {
            BUN_INSTALL_BIN: join(fixture, "explicit-bin"),
            BUN_INSTALL_GLOBAL_DIR: join(fixture, "explicit-global"),
          },
          options,
        ),
      ).resolves.toEqual({
        globalBinDir: join(fixture, "explicit-bin"),
        globalDir: join(fixture, "explicit-global"),
      });
      await expect(
        resolveBunGlobalLocations(
          {
            BUN_INSTALL: join(fixture, "explicit-install"),
            XDG_CACHE_HOME: "relative-cache-is-ignored",
          },
          options,
        ),
      ).resolves.toEqual({
        globalBinDir: join(fixture, "explicit-install", "bin"),
        globalDir: join(fixture, "explicit-install", "install", "global"),
      });
      await expect(
        resolveBunGlobalLocations({ XDG_CACHE_HOME: join(fixture, "cache-only") }, options),
      ).resolves.toEqual({
        globalBinDir: join(fixture, "cache-only", ".bun", "bin"),
        globalDir: join(fixture, "cache-only", ".bun", "install", "global"),
      });

      writeFileSync(join(xdgConfig, ".bunfig.toml"), "[install\nglobalBinDir = 42\n");
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CONFIG_HOME: xdgConfig }, options),
      ).rejects.toThrow("Cannot parse Bun configuration");

      writeFileSync(join(xdgConfig, ".bunfig.toml"), "[install]\nglobalBinDir = 42\n");
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CONFIG_HOME: xdgConfig }, options),
      ).rejects.toThrow("install.globalBinDir and install.globalDir must be strings");
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CONFIG_HOME: "relative/config" }, options),
      ).rejects.toThrow("XDG_CONFIG_HOME must be an absolute path");
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CONFIG_HOME: "" }, options),
      ).rejects.toThrow("XDG_CONFIG_HOME must be an absolute path; found (empty)");
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CACHE_HOME: "relative/cache" }, options),
      ).rejects.toThrow("XDG_CACHE_HOME must be an absolute path");
      await expect(
        resolveBunGlobalLocations({ HOME: home, XDG_CACHE_HOME: "" }, options),
      ).rejects.toThrow("XDG_CACHE_HOME must be an absolute path; found (empty)");
      await expect(
        resolveBunGlobalLocations({ BUN_INSTALL: "relative/bun", HOME: home }, options),
      ).rejects.toThrow("BUN_INSTALL must be an absolute filesystem path");
      await expect(
        resolveBunGlobalLocations({ BUN_INSTALL: "~/.bun", HOME: home }, options),
      ).rejects.toThrow("relative and tilde-prefixed values are unsupported");
      await expect(
        resolveBunGlobalLocations({ BUN_INSTALL_BIN: "", HOME: home }, options),
      ).rejects.toThrow("BUN_INSTALL_BIN must name a non-empty filesystem path");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("serializes canonical registry resources and fails closed on every existing lease", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-link-registry-lock-"));
    try {
      const locations = {
        globalBinDir: join(fixture, "bin"),
        globalDir: join(fixture, "global"),
      };
      const alias = join(fixture, "alias");
      symlinkSync(fixture, alias);
      const directLockPaths = await stationLinkRegistryLockPaths(locations);
      await expect(
        stationLinkRegistryLockPaths({
          globalBinDir: join(alias, "bin"),
          globalDir: join(alias, "global"),
        }),
      ).resolves.toEqual(directLockPaths);

      const collisionResource = join(fixture, "collision-resource");
      const collidingLockResource = `${collisionResource}.station-link-registry.lock`;
      mkdirSync(collisionResource);
      mkdirSync(collidingLockResource);
      await expect(
        stationLinkRegistryLockPaths({
          globalBinDir: collisionResource,
          globalDir: collidingLockResource,
        }),
      ).rejects.toThrow("collides with another resource's lock path");
      expect(lstatSync(collisionResource).isDirectory()).toBe(true);
      expect(lstatSync(collidingLockResource).isDirectory()).toBe(true);

      const lowerCaseProbe = join(fixture, "case-probe");
      const upperCaseProbe = join(fixture, "CASE-PROBE");
      mkdirSync(lowerCaseProbe);
      let caseInsensitive = false;
      try {
        caseInsensitive = realpathSync(upperCaseProbe) === realpathSync(lowerCaseProbe);
      } catch {
        caseInsensitive = false;
      }
      rmSync(lowerCaseProbe, { recursive: true });
      if (caseInsensitive) {
        const upperCaseLocks = await stationLinkRegistryLockPaths({
          globalBinDir: upperCaseProbe,
          globalDir: locations.globalDir,
        });
        const lowerCaseLocks = await stationLinkRegistryLockPaths({
          globalBinDir: lowerCaseProbe,
          globalDir: locations.globalDir,
        });
        expect(upperCaseLocks).toEqual(lowerCaseLocks);
      }

      const danglingAlias = join(fixture, "dangling-registry");
      symlinkSync(join(fixture, "missing-registry"), danglingAlias);
      await expect(
        stationLinkRegistryLockPaths({
          globalBinDir: danglingAlias,
          globalDir: locations.globalDir,
        }),
      ).rejects.toThrow("is a dangling symlink; refusing to choose a different lock identity");

      let overlappingMutationRan = false;
      await withStationLinkRegistryLocks(locations, async () => {
        await expect(
          withStationLinkRegistryLocks(locations, async () => {
            overlappingMutationRan = true;
          }),
        ).rejects.toThrow(
          new RegExp(`Another Station link-registry operation is active .*pid ${process.pid}`),
        );
      });
      expect(overlappingMutationRan).toBe(false);
      expect(
        (await stationLinkRegistryLockPaths(locations)).every((path) => !existsSync(path)),
      ).toBe(true);

      const [deadLock] = await stationLinkRegistryLockPaths(locations);
      if (deadLock === undefined) throw new Error("Expected a registry lock path.");
      mkdirSync(deadLock, { recursive: true });
      writeFileSync(
        join(deadLock, "owner.json"),
        `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" })}\n`,
      );
      let deadOwnerMutationRan = false;
      await expect(
        withStationLinkRegistryLocks(locations, async () => {
          deadOwnerMutationRan = true;
        }),
      ).rejects.toThrow(
        `Station link-registry lock at ${deadLock} belongs to non-running pid 2147483647`,
      );
      expect(deadOwnerMutationRan).toBe(false);
      expect(existsSync(deadLock)).toBe(true);
      rmSync(deadLock, { recursive: true });

      mkdirSync(deadLock);
      let emptyLockMutationRan = false;
      await expect(
        withStationLinkRegistryLocks(locations, async () => {
          emptyLockMutationRan = true;
        }),
      ).rejects.toThrow(`Cannot verify Station registry lock ownership at ${deadLock}`);
      expect(emptyLockMutationRan).toBe(false);
      expect(existsSync(deadLock)).toBe(true);
      rmSync(deadLock, { recursive: true });

      await expect(
        withStationLinkRegistryLocks(locations, async () => "after-manual-removal"),
      ).resolves.toBe("after-manual-removal");

      const tamperedLocks = await stationLinkRegistryLockPaths(locations);
      const tamperedLock = tamperedLocks.at(-1);
      const otherLock = tamperedLocks.at(0);
      if (tamperedLock === undefined) throw new Error("Expected a registry lock path.");
      if (otherLock === undefined || otherLock === tamperedLock) {
        throw new Error("Expected two distinct registry lock paths.");
      }
      await expect(
        withStationLinkRegistryLocks(locations, async () => {
          writeFileSync(
            join(tamperedLock, "owner.json"),
            `${JSON.stringify({ pid: process.pid, token: "replacement-owner" })}\n`,
          );
        }),
      ).rejects.toThrow("Refusing to release a Station registry lock owned by another process");
      expect(existsSync(tamperedLock)).toBe(true);
      expect(existsSync(otherLock)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("links only the fixed Station registration and launchers in one resolved snapshot", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-link-registry-pin-"));
    try {
      const home = join(fixture, "home");
      const xdgConfig = join(fixture, "xdg-config");
      const checkout = join(fixture, "checkout");
      const commandLog = join(fixture, "command.log");
      const fakeBun = join(fixture, "bun");
      const locations = {
        globalBinDir: join(fixture, "bin"),
        globalDir: join(fixture, "global"),
      };
      const launchers = {
        stn: "./bin/stn",
        "stn-ingress": "./bin/stn-ingress",
        "stn-tmux-popup": "./integrations/terminal/tmux/bin/stn-popup",
      };
      mkdirSync(home, { recursive: true });
      mkdirSync(xdgConfig, { recursive: true });
      mkdirSync(checkout, { recursive: true });
      writeFileSync(
        join(checkout, "package.json"),
        `${JSON.stringify({ name: "station", bin: launchers })}\n`,
      );
      for (const target of Object.values(launchers)) {
        const path = join(checkout, target);
        mkdirSync(join(path, ".."), { recursive: true });
        writeExecutable(path, 'printf "fixture\\n"\n');
      }
      writeFileSync(
        join(checkout, "bunfig.toml"),
        `[install]\nglobalBinDir = ${JSON.stringify(locations.globalBinDir)}\nglobalDir = ${JSON.stringify(locations.globalDir)}\n`,
      );
      writeExecutable(
        fakeBun,
        'printf "unexpected child dispatch\\n" > "$STATION_REGISTRY_COMMAND_LOG"\nexit 93\n',
      );
      const environment = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: xdgConfig,
        STATION_REGISTRY_COMMAND_LOG: commandLog,
      };
      delete environment.BUN_INSTALL;
      delete environment.BUN_INSTALL_BIN;
      delete environment.BUN_INSTALL_GLOBAL_DIR;

      await mutateStationLinkRegistry("link", {
        root: checkout,
        bunExecutable: fakeBun,
        environment,
      });

      expect(existsSync(commandLog)).toBe(false);
      const registration = join(locations.globalDir, "node_modules", "station");
      expect(lstatSync(registration).isSymbolicLink()).toBe(true);
      expect(realpathSync(registration)).toBe(realpathSync(checkout));
      for (const [launcher, target] of Object.entries(launchers)) {
        const destination = join(locations.globalBinDir, launcher);
        expect(lstatSync(destination).isSymbolicLink()).toBe(true);
        expect(realpathSync(destination)).toBe(realpathSync(join(checkout, target)));
      }

      rmSync(join(locations.globalBinDir, "stn"));
      symlinkSync(
        join(fixture, "deleted-checkout", "bin", "stn"),
        join(locations.globalBinDir, "stn"),
      );
      await mutateStationLinkRegistry("link", {
        root: checkout,
        bunExecutable: fakeBun,
        environment,
      });
      await expect(
        assertStationLinkOwnership(checkout, locations, "link"),
      ).resolves.toBeUndefined();

      const checkoutB = join(fixture, "checkout-b");
      mkdirSync(checkoutB, { recursive: true });
      writeFileSync(
        join(checkoutB, "package.json"),
        `${JSON.stringify({ name: "station", bin: launchers })}\n`,
      );
      for (const target of Object.values(launchers)) {
        const path = join(checkoutB, target);
        mkdirSync(join(path, ".."), { recursive: true });
        writeExecutable(path, 'printf "fixture-b\\n"\n');
      }
      writeFileSync(
        join(checkoutB, "bunfig.toml"),
        `[install]\nglobalBinDir = ${JSON.stringify(locations.globalBinDir)}\nglobalDir = ${JSON.stringify(locations.globalDir)}\n`,
      );
      await mutateStationLinkRegistry("link", {
        root: checkoutB,
        bunExecutable: fakeBun,
        environment,
      });
      await expect(
        assertStationLinkOwnership(checkoutB, locations, "link"),
      ).resolves.toBeUndefined();
      await expect(assertStationLinkOwnership(checkout, locations, "link")).rejects.toThrow(
        "belongs to another checkout",
      );

      const registryDestinations = [
        registration,
        ...Object.keys(launchers).map((launcher) => join(locations.globalBinDir, launcher)),
      ];
      const checkoutBLinkTargets = registryDestinations.map((path) => readlinkSync(path));
      let installedEntries = 0;
      await expect(
        mutateStationLinkRegistry("link", {
          root: checkout,
          bunExecutable: fakeBun,
          environment,
          afterLinkEntry: () => {
            installedEntries += 1;
            if (installedEntries === 2) throw new Error("injected mid-link failure");
          },
        }),
      ).rejects.toThrow("injected mid-link failure");
      expect(registryDestinations.map((path) => readlinkSync(path))).toEqual(checkoutBLinkTargets);
      expect(
        [
          ...readdirSync(locations.globalBinDir),
          ...readdirSync(join(locations.globalDir, "node_modules")),
        ].filter((name) => name.includes(".station-link-") || name.includes(".station-unlink-")),
      ).toEqual([]);
      await expect(
        assertStationLinkOwnership(checkoutB, locations, "link"),
      ).resolves.toBeUndefined();

      installedEntries = 0;
      await expect(
        mutateStationLinkRegistry("link", {
          root: checkout,
          bunExecutable: fakeBun,
          environment,
          afterLinkEntry: () => {
            installedEntries += 1;
            if (installedEntries === registryDestinations.length) {
              chmodSync(join(checkout, launchers.stn), 0o644);
            }
          },
        }),
      ).rejects.toThrow("must be a regular executable file inside the checkout");
      expect(registryDestinations.map((path) => readlinkSync(path))).toEqual(checkoutBLinkTargets);
      chmodSync(join(checkout, launchers.stn), 0o755);
      await expect(
        assertStationLinkOwnership(checkoutB, locations, "link"),
      ).resolves.toBeUndefined();
      expect(
        (await stationLinkRegistryLockPaths(locations)).every((path) => !existsSync(path)),
      ).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses checkout-local launcher destinations and direct files before unlinking", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-link-registry-overlap-"));
    try {
      const checkout = join(fixture, "checkout");
      const fakeBun = join(fixture, "bun");
      const globalDir = join(fixture, "global");
      const xdgConfig = join(fixture, "xdg-config");
      const launchers = {
        stn: "./bin/stn",
        "stn-ingress": "./bin/stn-ingress",
        "stn-tmux-popup": "./integrations/terminal/tmux/bin/stn-popup",
      };
      mkdirSync(checkout, { recursive: true });
      mkdirSync(xdgConfig, { recursive: true });
      writeFileSync(
        join(checkout, "package.json"),
        `${JSON.stringify({ name: "station", bin: launchers })}\n`,
      );
      for (const target of Object.values(launchers)) {
        const path = join(checkout, target);
        mkdirSync(join(path, ".."), { recursive: true });
        writeExecutable(path, 'printf "fixture\\n"\n');
      }
      writeFileSync(
        join(checkout, "bunfig.toml"),
        `[install]\nglobalBinDir = "./bin"\nglobalDir = ${JSON.stringify(globalDir)}\n`,
      );
      writeExecutable(fakeBun, "exit 0\n");
      const environment = { ...process.env, HOME: fixture, XDG_CONFIG_HOME: xdgConfig };
      delete environment.BUN_INSTALL;
      delete environment.BUN_INSTALL_BIN;
      delete environment.BUN_INSTALL_GLOBAL_DIR;

      await expect(
        mutateStationLinkRegistry("link", {
          root: checkout,
          environment,
          bunExecutable: fakeBun,
        }),
      ).rejects.toThrow("global launcher stn destination overlaps its source");
      expect(lstatSync(join(checkout, "bin", "stn")).isSymbolicLink()).toBe(false);

      const registration = join(globalDir, "node_modules", "station");
      mkdirSync(join(globalDir, "node_modules"), { recursive: true });
      symlinkSync(checkout, registration);
      await expect(
        mutateStationLinkRegistry("unlink", {
          root: checkout,
          environment,
          bunExecutable: fakeBun,
        }),
      ).rejects.toThrow("Refusing to unlink Station: global launcher stn is not a symlink");
      expect(lstatSync(registration).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(checkout, "bin", "stn")).isSymbolicLink()).toBe(false);

      const escapedLauncher = join(fixture, "escaped-stn");
      writeExecutable(escapedLauncher, "exit 0\n");
      rmSync(join(checkout, "bin", "stn"));
      symlinkSync(escapedLauncher, join(checkout, "bin", "stn"));
      await expect(
        mutateStationLinkRegistry("unlink", {
          root: checkout,
          environment,
          bunExecutable: fakeBun,
        }),
      ).rejects.toThrow("must be a regular executable file inside the checkout");
      expect(realpathSync(join(checkout, "bin", "stn"))).toBe(realpathSync(escapedLauncher));
      expect(lstatSync(registration).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("restores staged links when ownership changes after unlink preflight", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-link-registry-unlink-swap-"));
    try {
      const checkoutA = join(fixture, "checkout-a");
      const checkoutB = join(fixture, "checkout-b");
      const fakeBun = join(fixture, "bun");
      const xdgConfig = join(fixture, "xdg-config");
      const locations = {
        globalBinDir: join(fixture, "global-bin"),
        globalDir: join(fixture, "global-packages"),
      };
      const launchers = {
        stn: "./bin/stn",
        "stn-ingress": "./bin/stn-ingress",
        "stn-tmux-popup": "./integrations/terminal/tmux/bin/stn-popup",
      };
      mkdirSync(xdgConfig, { recursive: true });
      for (const checkout of [checkoutA, checkoutB]) {
        mkdirSync(checkout, { recursive: true });
        writeFileSync(
          join(checkout, "package.json"),
          `${JSON.stringify({ name: "station", bin: launchers })}\n`,
        );
        for (const target of Object.values(launchers)) {
          const path = join(checkout, target);
          mkdirSync(join(path, ".."), { recursive: true });
          writeExecutable(path, 'printf "fixture\\n"\n');
        }
        writeFileSync(
          join(checkout, "bunfig.toml"),
          `[install]\nglobalBinDir = ${JSON.stringify(locations.globalBinDir)}\nglobalDir = ${JSON.stringify(locations.globalDir)}\n`,
        );
      }
      writeExecutable(fakeBun, "exit 0\n");
      const environment = {
        ...process.env,
        HOME: fixture,
        XDG_CONFIG_HOME: xdgConfig,
      };
      delete environment.BUN_INSTALL;
      delete environment.BUN_INSTALL_BIN;
      delete environment.BUN_INSTALL_GLOBAL_DIR;
      await mutateStationLinkRegistry("link", {
        root: checkoutA,
        environment,
        bunExecutable: fakeBun,
      });

      const swappedLauncher = join(locations.globalBinDir, "stn");
      await expect(
        mutateStationLinkRegistry("unlink", {
          root: checkoutA,
          environment,
          bunExecutable: fakeBun,
          beforeMutation: () => {
            rmSync(swappedLauncher);
            symlinkSync(join(checkoutB, launchers.stn), swappedLauncher);
          },
        }),
      ).rejects.toThrow("global launcher stn belongs to another checkout");

      expect(realpathSync(swappedLauncher)).toBe(realpathSync(join(checkoutB, launchers.stn)));
      expect(realpathSync(join(locations.globalDir, "node_modules", "station"))).toBe(
        realpathSync(checkoutA),
      );
      for (const launcher of ["stn-ingress", "stn-tmux-popup"] as const) {
        expect(realpathSync(join(locations.globalBinDir, launcher))).toBe(
          realpathSync(join(checkoutA, launchers[launcher])),
        );
      }
      expect(
        [
          ...readdirSync(locations.globalBinDir),
          ...readdirSync(join(locations.globalDir, "node_modules")),
        ].filter((name) => name.includes(".station-link-") || name.includes(".station-unlink-")),
      ).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a wrong ambient Bun before mutation and verifies the link postcondition", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "station-link-registry-bun-admission-"));
    try {
      const home = join(fixture, "home");
      const xdgConfig = join(fixture, "xdg-config");
      const checkout = join(fixture, "checkout");
      const bin = join(fixture, "bin");
      const bunLog = join(fixture, "bun.log");
      const locations = {
        globalBinDir: join(fixture, "global-bin"),
        globalDir: join(fixture, "global-packages"),
      };
      const launchers = {
        stn: "./bin/stn",
        "stn-ingress": "./bin/stn-ingress",
        "stn-tmux-popup": "./integrations/terminal/tmux/bin/stn-popup",
      };
      mkdirSync(home, { recursive: true });
      mkdirSync(xdgConfig, { recursive: true });
      mkdirSync(checkout, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(checkout, "package.json"),
        `${JSON.stringify({ name: "station", packageManager: "bun@1.4.0", bin: launchers })}\n`,
      );
      for (const target of Object.values(launchers)) {
        const path = join(checkout, target);
        mkdirSync(join(path, ".."), { recursive: true });
        writeExecutable(path, 'printf "fixture\\n"\n');
      }
      writeFileSync(
        join(checkout, "bunfig.toml"),
        `[install]\nglobalBinDir = ${JSON.stringify(locations.globalBinDir)}\nglobalDir = ${JSON.stringify(locations.globalDir)}\n`,
      );
      writeExecutable(
        join(bin, "bun"),
        [
          'printf "%s\\n" "$*" >> "$STATION_REGISTRY_BUN_LOG"',
          'if [ "$1" = "--version" ]; then echo "1.3.14"; exit 0; fi',
          "exit 91",
          "",
        ].join("\n"),
      );
      const environment = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: xdgConfig,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STATION_REGISTRY_BUN_LOG: bunLog,
      };
      delete environment.BUN_INSTALL;
      delete environment.BUN_INSTALL_BIN;
      delete environment.BUN_INSTALL_GLOBAL_DIR;

      await expect(
        mutateStationLinkRegistry("link", { root: checkout, environment }),
      ).rejects.toThrow("Station requires Bun 1.4.0; found 1.3.14");
      expect(readFileSync(bunLog, "utf8").trim().split("\n")).toEqual(["--version"]);
      await expect(
        mutateStationLinkRegistry("link", {
          root: checkout,
          environment,
          bunExecutable: undefined,
        }),
      ).rejects.toThrow("explicitly injected Bun executable must be an absolute path");

      writeExecutable(
        join(bin, "bun"),
        [
          'printf "%s\\n" "$*" >> "$STATION_REGISTRY_BUN_LOG"',
          'if [ "$1" = "--version" ]; then echo "1.4.0"; exit 0; fi',
          "exit 92",
          "",
        ].join("\n"),
      );
      const linkedLocations = await mutateStationLinkRegistry("link", {
        root: checkout,
        environment,
      });
      expect(linkedLocations).toEqual({
        globalBinDir: realpathSync(locations.globalBinDir),
        globalDir: realpathSync(locations.globalDir),
      });
      expect(readFileSync(bunLog, "utf8").trim().split("\n")).toEqual(["--version", "--version"]);
      await expect(
        assertStationLinkOwnership(checkout, locations, "link"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  const exactBun = findExactBun();
  it.skipIf(exactBun === undefined)(
    "ignores a malicious fourth manifest bin under the exact Bun runtime",
    async () => {
      if (exactBun === undefined) throw new Error(`Bun ${requiredExactBun} is required.`);
      const fixture = mkdtempSync(join(tmpdir(), "station-link-registry-fixed-bin-set-"));
      try {
        const checkout = join(fixture, "checkout");
        const hostileCwd = join(fixture, "hostile-cwd");
        const home = join(fixture, "home");
        const xdgConfig = join(fixture, "xdg-config");
        const locations = {
          globalBinDir: join(fixture, "global-bin"),
          globalDir: join(fixture, "global-packages"),
        };
        const launchers = {
          stn: "./bin/stn",
          "stn-ingress": "./bin/stn-ingress",
          "stn-tmux-popup": "./integrations/terminal/tmux/bin/stn-popup",
        };
        const unrelatedTarget = join(fixture, "unrelated-tool");
        const unrelatedLauncher = join(locations.globalBinDir, "unrelated-tool");
        mkdirSync(checkout, { recursive: true });
        mkdirSync(hostileCwd, { recursive: true });
        mkdirSync(home, { recursive: true });
        mkdirSync(xdgConfig, { recursive: true });
        mkdirSync(locations.globalBinDir, { recursive: true });
        writeFileSync(
          join(checkout, "package.json"),
          `${JSON.stringify({
            name: "station",
            version: "1.0.0",
            bin: { ...launchers, "unrelated-tool": "./malicious-tool" },
          })}\n`,
        );
        for (const target of [...Object.values(launchers), "./malicious-tool"]) {
          const path = join(checkout, target);
          mkdirSync(join(path, ".."), { recursive: true });
          writeExecutable(path, 'printf "fixture\\n"\n');
        }
        writeExecutable(unrelatedTarget, 'printf "unrelated\\n"\n');
        symlinkSync(unrelatedTarget, unrelatedLauncher);
        writeFileSync(
          join(checkout, "bunfig.toml"),
          `[install]\nglobalBinDir = ${JSON.stringify(locations.globalBinDir)}\nglobalDir = ${JSON.stringify(locations.globalDir)}\n`,
        );
        const environment = {
          ...process.env,
          BUN_OPTIONS: `--cwd ${hostileCwd}`,
          HOME: home,
          XDG_CONFIG_HOME: xdgConfig,
        };
        delete environment.BUN_INSTALL;
        delete environment.BUN_INSTALL_BIN;
        delete environment.BUN_INSTALL_GLOBAL_DIR;

        await mutateStationLinkRegistry("link", {
          root: checkout,
          environment,
          bunExecutable: exactBun,
        });
        await expect(
          assertStationLinkOwnership(checkout, locations, "link"),
        ).resolves.toBeUndefined();
        expect(lstatSync(unrelatedLauncher).isSymbolicLink()).toBe(true);
        expect(realpathSync(unrelatedLauncher)).toBe(realpathSync(unrelatedTarget));

        await mutateStationLinkRegistry("unlink", {
          root: checkout,
          environment,
          bunExecutable: exactBun,
        });
        expect(existsSync(join(locations.globalDir, "node_modules", "station"))).toBe(false);
        expect(
          Object.keys(launchers).every(
            (launcher) => !existsSync(join(locations.globalBinDir, launcher)),
          ),
        ).toBe(true);
        expect(lstatSync(unrelatedLauncher).isSymbolicLink()).toBe(true);
        expect(realpathSync(unrelatedLauncher)).toBe(realpathSync(unrelatedTarget));
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(exactBun === undefined)(
    "pins both Bun directories so a config race cannot unlink another checkout",
    async () => {
      if (exactBun === undefined) throw new Error(`Bun ${requiredExactBun} is required.`);
      const fixture = mkdtempSync(join(tmpdir(), "station-link-registry-race-"));
      try {
        const home = join(fixture, "home");
        const xdgConfig = join(fixture, "xdg-config");
        const checkoutA = join(fixture, "checkout-a");
        const checkoutB = join(fixture, "checkout-b");
        const locationsA = {
          globalBinDir: join(fixture, "bin-a"),
          globalDir: join(fixture, "global-a"),
        };
        const locationsB = {
          globalBinDir: join(fixture, "bin-b"),
          globalDir: join(fixture, "global-b"),
        };
        const launchers = {
          stn: "./bin/stn",
          "stn-ingress": "./bin/stn-ingress",
          "stn-tmux-popup": "./integrations/terminal/tmux/bin/stn-popup",
        };
        mkdirSync(home, { recursive: true });
        mkdirSync(xdgConfig, { recursive: true });
        for (const [checkout, locations] of [
          [checkoutA, locationsA],
          [checkoutB, locationsB],
        ] as const) {
          mkdirSync(checkout, { recursive: true });
          writeFileSync(
            join(checkout, "package.json"),
            `${JSON.stringify({ name: "station", version: "1.0.0", bin: launchers })}\n`,
          );
          for (const target of Object.values(launchers)) {
            const path = join(checkout, target);
            mkdirSync(join(path, ".."), { recursive: true });
            writeExecutable(path, 'printf "fixture\\n"\n');
          }
          writeFileSync(
            join(checkout, "bunfig.toml"),
            `[install]\nglobalBinDir = ${JSON.stringify(locations.globalBinDir)}\nglobalDir = ${JSON.stringify(locations.globalDir)}\n`,
          );
        }
        const environment = {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: xdgConfig,
        };
        delete environment.BUN_INSTALL;
        delete environment.BUN_INSTALL_BIN;
        delete environment.BUN_INSTALL_GLOBAL_DIR;
        delete environment.BUN_OPTIONS;
        for (const [checkout, locations] of [
          [checkoutA, locationsA],
          [checkoutB, locationsB],
        ] as const) {
          const linked = spawnSync(exactBun, ["link"], {
            cwd: checkout,
            encoding: "utf8",
            env: {
              ...environment,
              BUN_INSTALL_BIN: locations.globalBinDir,
              BUN_INSTALL_GLOBAL_DIR: locations.globalDir,
            },
          });
          expect(linked.status, linked.stderr).toBe(0);
        }

        await mutateStationLinkRegistry("unlink", {
          root: checkoutA,
          environment,
          bunExecutable: exactBun,
          beforeMutation: () => {
            writeFileSync(
              join(checkoutA, "bunfig.toml"),
              `[install]\nglobalBinDir = ${JSON.stringify(locationsB.globalBinDir)}\nglobalDir = ${JSON.stringify(locationsB.globalDir)}\n`,
            );
          },
        });

        expect(existsSync(join(locationsA.globalDir, "node_modules", "station"))).toBe(false);
        expect(
          Object.keys(launchers).every((name) => !existsSync(join(locationsA.globalBinDir, name))),
        ).toBe(true);
        expect(realpathSync(join(locationsB.globalDir, "node_modules", "station"))).toBe(
          realpathSync(checkoutB),
        );
        expect(
          Object.keys(launchers).every((name) =>
            realpathSync(join(locationsB.globalBinDir, name)).startsWith(realpathSync(checkoutB)),
          ),
        ).toBe(true);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
