import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { type GuidedPtyInput, runGuidedPty } from "../support/setup-guided";

const presenterModule = pathToFileURL(
  resolve("apps/cli/dist/commands/setup/presenters/clack.js"),
).href;

function runPresenterScenario(input: {
  readonly scenario: "confirm" | "multi" | "default";
  readonly inputs: readonly GuidedPtyInput[];
  readonly rows?: number;
  readonly columns?: number;
}) {
  return runGuidedPty({
    command: process.execPath,
    args: ["--input-type=module", "--eval", presenterScript],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      STATION_GUIDED_TTY_SCENARIO: input.scenario,
      STATION_CLACK_PRESENTER_MODULE: presenterModule,
    },
    inputs: input.inputs,
    rows: input.rows,
    columns: input.columns,
  });
}

describe("guided setup real TTY", () => {
  it("commits immediate yes and no without Enter", async () => {
    const yes = await runPresenterScenario({ scenario: "confirm", inputs: ["y"] });
    const no = await runPresenterScenario({ scenario: "confirm", inputs: ["n"] });

    expect(yes.timedOut).toBe(false);
    expect(no.timedOut).toBe(false);
    expect(yes.stdout).toContain("answer:true");
    expect(no.stdout).toContain("answer:false");
    expect(yes.answersSent).toBe(1);
    expect(no.answersSent).toBe(1);
  });

  it("normalizes Ctrl-C as typed cancellation with status 1", async () => {
    const result = await runPresenterScenario({ scenario: "confirm", inputs: ["cancel"] });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Setup cancelled. Changes already completed were kept.");
    expect(result.stdout).not.toContain("Symbol(");
  });

  it("reprompts an empty required multiselect without a catalog fallback", async () => {
    const result = await runPresenterScenario({
      scenario: "multi",
      inputs: ["enter", "2"],
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Select at least one available agent CLI.");
    expect(result.stdout).toContain("selected:codex");
    expect(result.stdout).not.toContain("selected:claude");
  });

  it("keeps the fifth agent navigable in a constrained terminal", async () => {
    const result = await runPresenterScenario({
      scenario: "multi",
      inputs: ["5"],
      rows: 8,
      columns: 62,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("5 agent choices are available.");
    expect(result.stdout).toContain("selected:pi");
  });

  it("requires an explicit default after multiple new-config selections", async () => {
    const result = await runPresenterScenario({
      scenario: "default",
      inputs: ["1,2", "select:2"],
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Choose the default agent for the new config.");
    expect(result.stdout).toContain("selected:claude,codex");
    expect(result.stdout).toContain("default:codex");
    expect(result.stdout).toContain("raw-mode-after:false");
  });

  it("normalizes the happy interaction without structured Station output", async () => {
    const result = await runPresenterScenario({
      scenario: "default",
      inputs: ["1,2", "select:1"],
      rows: 24,
      columns: 100,
    });
    expect(result.stdout).toContain("Selected changes");
    expect(result.stdout).toContain("Choose the default agent for the new config.");
    expect(result.stdout).toContain("raw-mode-after:false");
    expect(result.stdout).not.toContain("operationId");
    expect(result.stdout).not.toContain("providerData");
    expect(result.stdout).not.toContain('"status":');
    expect(result.stdout).not.toContain("[object Object]");
    expect(result.stdout).not.toContain('["stn",');
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        expect(() => JSON.parse(trimmed)).toThrow();
      }
    }
  });
});

const presenterScript = String.raw`
const { createClackSetupPresenter } = await import(process.env.STATION_CLACK_PRESENTER_MODULE);
const presenter = createClackSetupPresenter();
const scenario = process.env.STATION_GUIDED_TTY_SCENARIO;
const choices = [
  { value: "claude", label: "Claude Code", hint: "Anthropic CLI" },
  { value: "codex", label: "Codex", hint: "OpenAI CLI" },
  { value: "cursor", label: "Cursor Agent", hint: "Cursor CLI" },
  { value: "opencode", label: "OpenCode", hint: "OpenCode CLI" },
  { value: "pi", label: "Pi", hint: "Pi CLI" },
];
presenter.intro("Station setup");
presenter.logInfo("Set up required tools and one or more agents.");
if (scenario === "confirm") {
  const answer = await presenter.confirm({ message: "Continue with setup?" });
  if (answer.kind === "cancelled") {
    presenter.cancel("Setup cancelled. Changes already completed were kept.");
    process.exitCode = 1;
  } else {
    presenter.outro("answer:" + answer.value);
  }
} else {
  let answer;
  do {
    answer = await presenter.selectMany({
      message: "Select agent CLIs to prepare.\n5 agent choices are available.\nUse arrows, Space, and Enter.",
      choices,
    });
    if (answer.kind === "cancelled") {
      presenter.cancel("Setup cancelled. Changes already completed were kept.");
      process.exitCode = 1;
      break;
    }
    if (answer.value.length === 0) {
      presenter.logWarn("Select at least one available agent CLI.");
    }
  } while (answer.value.length === 0);
  if (answer?.kind === "answered" && answer.value.length > 0) {
    presenter.note("Will apply\n- Prepare selected agents", "Selected changes");
    presenter.logStep("Prepare selected agents");
    presenter.logSuccess("Selected agents prepared");
    presenter.logInfo("selected:" + answer.value.join(","));
    if (scenario === "default" && answer.value.length > 1) {
      const selectedChoices = choices.filter((choice) => answer.value.includes(choice.value));
      const defaultAnswer = await presenter.selectOne({
        message: "Choose the default agent for the new config.",
        choices: selectedChoices,
        initialValue: answer.value[0],
      });
      if (defaultAnswer.kind === "answered") {
        presenter.logInfo("default:" + defaultAnswer.value);
      }
    }
    presenter.outro("Setup complete.");
    process.stdout.write("raw-mode-after:" + String(process.stdin.isRaw === true) + "\n");
  }
}
`;
