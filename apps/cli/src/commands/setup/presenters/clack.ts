import type { Readable, Writable } from "node:stream";
import * as clack from "@clack/prompts";
import { resolveSetupMessage, setupMessageRef } from "@station/setup-messages";
import type { SetupPromptAdapter, SetupPromptAnswer, SetupPromptChoice } from "../types.js";

type InteractiveReadable = Readable & { readonly isTTY?: boolean };
type InteractiveWritable = Writable & { readonly isTTY?: boolean };

type ClackCommonOptions = {
  readonly input: Readable;
  readonly output: Writable;
};

type ClackOption = {
  value: string;
  label: string;
  hint?: string;
};

type ClackConfirmOptions = ClackCommonOptions & {
  readonly message: string;
  readonly initialValue: boolean;
  readonly active: string;
  readonly inactive: string;
};

type ClackSelectOptions = ClackCommonOptions & {
  message: string;
  options: ClackOption[];
  showInstructions: false;
  initialValue?: string;
};

type ClackMultiselectOptions = ClackCommonOptions & {
  message: string;
  options: ClackOption[];
  showInstructions: false;
  required: false;
  initialValues?: string[];
};

export type ClackFunctions = {
  readonly confirm: (options: ClackConfirmOptions) => Promise<unknown>;
  readonly select: (options: ClackSelectOptions) => Promise<unknown>;
  readonly multiselect: (options: ClackMultiselectOptions) => Promise<unknown>;
  readonly isCancel: (value: unknown) => boolean;
  readonly intro: (message?: string, options?: ClackCommonOptions) => void;
  readonly outro: (message?: string, options?: ClackCommonOptions) => void;
  readonly cancel: (message?: string, options?: ClackCommonOptions) => void;
  readonly note: (message?: string, title?: string, options?: ClackCommonOptions) => void;
  readonly log: {
    readonly step: (message: string, options?: ClackCommonOptions) => void;
    readonly success: (message: string, options?: ClackCommonOptions) => void;
    readonly warn: (message: string, options?: ClackCommonOptions) => void;
    readonly error: (message: string, options?: ClackCommonOptions) => void;
    readonly info: (message: string, options?: ClackCommonOptions) => void;
  };
};

export type CreateClackSetupPresenterOptions = {
  readonly input?: InteractiveReadable;
  readonly output?: InteractiveWritable;
  readonly clack?: ClackFunctions;
};

const productionClack: ClackFunctions = {
  confirm: clack.confirm,
  select: clack.select,
  multiselect: clack.multiselect,
  isCancel: clack.isCancel,
  intro: clack.intro,
  outro: clack.outro,
  cancel: clack.cancel,
  note: clack.note,
  log: clack.log,
};

/**
 * ADAPTER
 *
 * Translates guided setup interaction and progress into Clack controls while
 * normalizing terminal cancellation before it reaches session orchestration.
 */
export function createClackSetupPresenter(
  options: CreateClackSetupPresenterOptions = {},
): SetupPromptAdapter {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const clack = options.clack ?? productionClack;
  const common = { input, output };
  const yesLabel = resolveSetupMessage(setupMessageRef("guided.yes-label"));
  const noLabel = resolveSetupMessage(setupMessageRef("guided.no-label"));

  return {
    isInteractiveTerminal: () => input.isTTY === true && output.isTTY === true,
    intro: (heading) => clack.intro(heading, common),
    outro: (closingMessage) => clack.outro(closingMessage, common),
    cancel: (cancellationMessage) => clack.cancel(cancellationMessage, common),
    async confirm(request) {
      const value = await clack.confirm({
        ...common,
        message: request.message,
        initialValue: false,
        active: yesLabel,
        inactive: noLabel,
      });
      return normalizeClackAnswer<boolean>({ value, detectCancellation: clack.isCancel });
    },
    async selectOne(request) {
      const selectOptions: ClackSelectOptions = {
        ...common,
        message: request.message,
        options: request.choices.map(toClackOption),
        showInstructions: false,
      };
      if (request.initialValue !== undefined) {
        selectOptions.initialValue = request.initialValue;
      }
      const value = await clack.select(selectOptions);
      return normalizeClackAnswer<string>({ value, detectCancellation: clack.isCancel });
    },
    async selectMany(request) {
      const multiselectOptions: ClackMultiselectOptions = {
        ...common,
        message: request.message,
        options: request.choices.map(toClackOption),
        showInstructions: false,
        required: false,
      };
      if (request.initialValues !== undefined) {
        multiselectOptions.initialValues = [...request.initialValues];
      }
      const value = await clack.multiselect(multiselectOptions);
      return normalizeClackAnswer<readonly string[]>({
        value,
        detectCancellation: clack.isCancel,
      });
    },
    note: (...noteArguments) => clack.note(noteArguments[0], noteArguments[1], common),
    logStep: (stepMessage) => clack.log.step(stepMessage, common),
    logSuccess: (successMessage) => clack.log.success(successMessage, common),
    logWarn: (warningMessage) => clack.log.warn(warningMessage, common),
    logError: (errorMessage) => clack.log.error(errorMessage, common),
    logInfo: (informationMessage) => clack.log.info(informationMessage, common),
  };
}

function normalizeClackAnswer<T>(input: {
  readonly value: unknown;
  readonly detectCancellation: ClackFunctions["isCancel"];
}): SetupPromptAnswer<T> {
  return input.detectCancellation(input.value)
    ? { kind: "cancelled" }
    : { kind: "answered", value: input.value as T };
}

function toClackOption(choice: SetupPromptChoice): ClackOption {
  const option: ClackOption = { value: choice.value, label: choice.label };
  if (choice.hint !== undefined) option.hint = choice.hint;
  return option;
}
