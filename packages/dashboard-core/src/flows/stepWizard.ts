export type StepWizardState<TStep extends string> = {
  mode: TStep;
  stepHistory: TStep[];
};

type WizardStateWithMode<
  TState extends StepWizardState<string>,
  TMode extends TState["mode"],
> = Omit<TState, "mode" | "stepHistory"> & {
  mode: TMode;
  stepHistory: TState["stepHistory"];
};

export function createStepWizardState<TStep extends string>(mode: TStep): StepWizardState<TStep> {
  return {
    mode,
    stepHistory: [],
  };
}

export function enterWizardStep<
  TState extends StepWizardState<string>,
  TMode extends TState["mode"],
>(state: TState, mode: TMode): WizardStateWithMode<TState, TMode> {
  return {
    ...state,
    mode,
    stepHistory: [...state.stepHistory, state.mode],
  } as WizardStateWithMode<TState, TMode>;
}

export function resetWizardStep<
  TState extends StepWizardState<string>,
  TMode extends TState["mode"],
>(state: TState, mode: TMode): WizardStateWithMode<TState, TMode> {
  return {
    ...state,
    mode,
    stepHistory: [],
  } as WizardStateWithMode<TState, TMode>;
}

export function backWizardStep<TState extends StepWizardState<string>>(state: TState) {
  const previous = state.stepHistory.at(-1);
  if (previous === undefined) {
    return undefined;
  }
  return {
    ...state,
    mode: previous,
    stepHistory: state.stepHistory.slice(0, -1),
  };
}
