import type { SafeError } from "@station/contracts";

export class HarnessProviderError<TCode extends string = string>
  extends Error
  implements SafeError
{
  readonly tag = "HarnessProviderError";
  readonly code: TCode;
  readonly provider: string;
  readonly hint: string | undefined;

  constructor(input: {
    name: string;
    provider: string;
    code: TCode;
    message: string;
    cause?: unknown;
    hint?: string | undefined;
  }) {
    super(`${input.code}: ${input.message}`, { cause: input.cause });
    Object.defineProperty(this, "name", {
      value: input.name,
      configurable: true,
    });
    this.provider = input.provider;
    this.code = input.code;
    this.hint = input.hint;
  }
}

export type HarnessProviderErrorClass<TCode extends string> = new (
  code: TCode,
  message: string,
  options?: { cause?: unknown; hint?: string | undefined },
) => HarnessProviderError<TCode>;

export function harnessProviderErrorClass<TCode extends string>(input: {
  name: string;
  provider: string;
}): HarnessProviderErrorClass<TCode> {
  return class extends HarnessProviderError<TCode> {
    constructor(
      code: TCode,
      message: string,
      options: { cause?: unknown; hint?: string | undefined } = {},
    ) {
      super({
        name: input.name,
        provider: input.provider,
        code,
        message,
        cause: options.cause,
        hint: options.hint,
      });
    }
  };
}

// Returns the error unchanged when it is already an instance of the provider error class; otherwise
// wraps it with the fallback code/message, preserving the original as `cause`.
export function harnessProviderErrorFromUnknown<TCode extends string>(
  ErrorClass: HarnessProviderErrorClass<TCode>,
  error: unknown,
  fallback: { code: TCode; message: string; hint?: string | undefined },
): HarnessProviderError<TCode> {
  if (error instanceof ErrorClass) {
    return error;
  }
  const options: { cause?: unknown; hint?: string } = { cause: error };
  if (fallback.hint !== undefined) {
    options.hint = fallback.hint;
  }
  return new ErrorClass(fallback.code, fallback.message, options);
}

export type HarnessProviderErrors<TCode extends string> = {
  ErrorClass: HarnessProviderErrorClass<TCode>;
  create: (code: TCode, message: string, cause?: unknown) => HarnessProviderError<TCode>;
  fromUnknown: (
    error: unknown,
    fallback: { code: TCode; message: string; hint?: string | undefined },
  ) => HarnessProviderError<TCode>;
};

export function defineHarnessProviderErrors<TCode extends string>(input: {
  name: string;
  provider: string;
}): HarnessProviderErrors<TCode> {
  const ErrorClass = harnessProviderErrorClass<TCode>(input);
  return {
    ErrorClass,
    create: (code, message, cause) => new ErrorClass(code, message, { cause }),
    fromUnknown: (error, fallback) => harnessProviderErrorFromUnknown(ErrorClass, error, fallback),
  };
}
