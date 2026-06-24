export type ProjectConfigSafeError = Error & {
  tag: "ProjectConfigError";
  code: string;
  hint?: string;
  projectId?: string;
};

export function projectConfigSafeError(options: {
  code: string;
  message: string;
  hint?: string;
  projectId?: string;
  cause?: unknown;
}): ProjectConfigSafeError {
  const error = new Error(options.message, { cause: options.cause }) as ProjectConfigSafeError;
  error.name = "ProjectConfigError";
  error.tag = "ProjectConfigError";
  error.code = options.code;
  if (options.hint !== undefined) {
    error.hint = options.hint;
  }
  if (options.projectId !== undefined) {
    error.projectId = options.projectId;
  }
  return error;
}

export function isProjectSafeError(error: unknown): error is ProjectConfigSafeError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { tag?: unknown }).tag === "ProjectConfigError"
  );
}
