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

export function harnessProviderErrorClass<TCode extends string>(input: {
  name: string;
  provider: string;
}): new (
  code: TCode,
  message: string,
  options?: { cause?: unknown; hint?: string | undefined },
) => HarnessProviderError<TCode> {
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
