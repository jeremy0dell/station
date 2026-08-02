import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type ClackFunctions,
  createClackSetupPresenter,
} from "../../src/commands/setup/presenters/clack.js";

function interactiveStream() {
  return Object.assign(new PassThrough(), { isTTY: true as boolean });
}

function clackFixture(input: {
  readonly confirmValue?: unknown;
  readonly selectValue?: unknown;
  readonly multiselectValue?: unknown;
  readonly cancellation?: unknown;
}) {
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const clack: ClackFunctions = {
    async confirm(options) {
      record("confirm", options);
      return input.confirmValue ?? false;
    },
    async select(options) {
      record("select", options);
      return input.selectValue ?? "codex";
    },
    async multiselect(options) {
      record("multiselect", options);
      return input.multiselectValue ?? ["codex"];
    },
    isCancel(value) {
      return value === input.cancellation;
    },
    intro(...args) {
      record("intro", ...args);
    },
    outro(...args) {
      record("outro", ...args);
    },
    cancel(...args) {
      record("cancel", ...args);
    },
    note(...args) {
      record("note", ...args);
    },
    log: {
      step: (...args) => record("log.step", ...args),
      success: (...args) => record("log.success", ...args),
      warn: (...args) => record("log.warn", ...args),
      error: (...args) => record("log.error", ...args),
      info: (...args) => record("log.info", ...args),
    },
  };
  return { calls, clack };
}

describe("Clack setup presenter", () => {
  it("maps confirmation and selections through an injected plain function object", async () => {
    const input = interactiveStream();
    const output = interactiveStream();
    const fixture = clackFixture({
      confirmValue: true,
      selectValue: "opencode",
      multiselectValue: ["codex", "opencode"],
    });
    const presenter = createClackSetupPresenter({ input, output, clack: fixture.clack });

    await expect(presenter.confirm({ message: "Continue?" })).resolves.toEqual({
      kind: "answered",
      value: true,
    });
    await expect(
      presenter.selectMany({
        message: "Select agents",
        choices: [
          { value: "codex", label: "Codex" },
          { value: "opencode", label: "OpenCode", hint: "Current default" },
        ],
      }),
    ).resolves.toEqual({ kind: "answered", value: ["codex", "opencode"] });
    await expect(
      presenter.selectMany({
        message: "Keep current default",
        choices: [{ value: "opencode", label: "OpenCode" }],
        initialValues: ["opencode"],
      }),
    ).resolves.toEqual({ kind: "answered", value: ["codex", "opencode"] });
    await expect(
      presenter.selectOne({
        message: "Choose default",
        choices: [{ value: "opencode", label: "OpenCode" }],
        initialValue: "opencode",
      }),
    ).resolves.toEqual({ kind: "answered", value: "opencode" });

    const confirmOptions = fixture.calls.find((call) => call.method === "confirm")?.args[0];
    expect(confirmOptions).toMatchObject({
      message: "Continue?",
      initialValue: false,
      active: "Yes",
      inactive: "No",
      input,
      output,
    });
    const manyOptions = fixture.calls.find((call) => call.method === "multiselect")?.args[0];
    expect(manyOptions).toMatchObject({
      message: "Select agents",
      required: false,
      showInstructions: false,
      input,
      output,
      options: [
        { value: "codex", label: "Codex" },
        { value: "opencode", label: "OpenCode", hint: "Current default" },
      ],
    });
    expect(manyOptions).not.toHaveProperty("initialValues");
    expect((manyOptions as { options: object[] }).options[0]).not.toHaveProperty("hint");
    const initializedManyOptions = fixture.calls.filter((call) => call.method === "multiselect")[1]
      ?.args[0];
    expect(initializedManyOptions).toMatchObject({ initialValues: ["opencode"] });
    const oneOptions = fixture.calls.find((call) => call.method === "select")?.args[0];
    expect(oneOptions).toMatchObject({
      message: "Choose default",
      showInstructions: false,
      initialValue: "opencode",
      options: [{ value: "opencode", label: "OpenCode" }],
      input,
      output,
    });
  });

  it("normalizes every Clack cancellation before returning", async () => {
    const cancellation = Symbol("cancel");
    const fixture = clackFixture({
      cancellation,
      confirmValue: cancellation,
      selectValue: cancellation,
      multiselectValue: cancellation,
    });
    const presenter = createClackSetupPresenter({
      input: interactiveStream(),
      output: interactiveStream(),
      clack: fixture.clack,
    });

    await expect(presenter.confirm({ message: "Continue?" })).resolves.toEqual({
      kind: "cancelled",
    });
    await expect(
      presenter.selectOne({ message: "One", choices: [{ value: "codex", label: "Codex" }] }),
    ).resolves.toEqual({ kind: "cancelled" });
    await expect(
      presenter.selectMany({
        message: "Many",
        choices: [{ value: "codex", label: "Codex" }],
      }),
    ).resolves.toEqual({ kind: "cancelled" });
  });

  it("maps guide, note, and compact log methods with configured streams", () => {
    const input = interactiveStream();
    const output = interactiveStream();
    const fixture = clackFixture({});
    const presenter = createClackSetupPresenter({ input, output, clack: fixture.clack });

    presenter.intro("Station setup");
    presenter.note("- Write config", "Selected changes");
    presenter.logStep("Write config");
    presenter.logSuccess("Config written");
    presenter.logWarn("Retry setup");
    presenter.logError("Config failed");
    presenter.logInfo("Inspecting");
    presenter.outro("Complete");
    presenter.cancel("Cancelled");

    for (const call of fixture.calls) {
      expect(call.args.at(-1)).toEqual({ input, output });
    }
    expect(fixture.calls.map((call) => call.method)).toEqual([
      "intro",
      "note",
      "log.step",
      "log.success",
      "log.warn",
      "log.error",
      "log.info",
      "outro",
      "cancel",
    ]);
  });

  it("requires both configured streams to be interactive", () => {
    const clack = clackFixture({}).clack;
    const interactive = interactiveStream();
    const noninteractive = new PassThrough();

    expect(
      createClackSetupPresenter({
        input: interactive,
        output: interactiveStream(),
        clack,
      }).isInteractiveTerminal(),
    ).toBe(true);
    expect(
      createClackSetupPresenter({
        input: noninteractive,
        output: interactiveStream(),
        clack,
      }).isInteractiveTerminal(),
    ).toBe(false);
    expect(
      createClackSetupPresenter({
        input: interactiveStream(),
        output: noninteractive,
        clack,
      }).isInteractiveTerminal(),
    ).toBe(false);
  });

  it("does not require a package-global mock", () => {
    const fixture = clackFixture({});
    expect(vi.isMockFunction(fixture.clack.confirm)).toBe(false);
  });
});
