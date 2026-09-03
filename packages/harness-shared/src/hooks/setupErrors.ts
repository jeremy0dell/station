import type { ProviderHookArtifactOwnership } from "@station/contracts";
import { createHookSetupFileOps, type HookSetupFileOps } from "@station/runtime";

export type HookSetupErrorClass<TCode extends string> = new (
  code: TCode,
  message: string,
  options?: { cause?: unknown },
) => Error & { readonly tag: string; readonly code: TCode; readonly provider: string };

/** One provider's hook-setup error class. `tag` doubles as the non-enumerable `name`, and the
 * message is not code-prefixed, unlike the harness provider errors. */
export function hookSetupErrorClass<TCode extends string>(input: {
  tag: string;
  provider: string;
}): HookSetupErrorClass<TCode> {
  return class extends Error {
    readonly tag = input.tag;
    readonly provider = input.provider;
    readonly code: TCode;
    constructor(code: TCode, message: string, options: { cause?: unknown } = {}) {
      super(message, { cause: options.cause });
      Object.defineProperty(this, "name", {
        value: input.tag,
        enumerable: false,
        configurable: true,
      });
      this.code = code;
    }
  };
}

/** File ops whose failures carry the provider's own codes and wording. `removeTarget` exists
 * because Claude removes a settings artifact where Codex and Cursor remove only the script. */
export function hookSetupFileOpsFor<TCode extends string>(
  ErrorClass: HookSetupErrorClass<TCode>,
  codes: { unreadable: TCode; writeFailed: TCode },
  labels: { displayName: string; removeTarget: "file" | "script" },
): HookSetupFileOps {
  const name = labels.displayName;
  return createHookSetupFileOps(({ operation, cause }) => {
    if (operation === "read" || operation === "metadata") {
      return new ErrorClass(
        codes.unreadable,
        operation === "read"
          ? `${name} hook config could not be read.`
          : `${name} hook config metadata could not be read.`,
        { cause },
      );
    }
    return new ErrorClass(
      codes.writeFailed,
      operation === "remove"
        ? `${name} hook ${labels.removeTarget} could not be removed.`
        : operation === "writeScript"
          ? `${name} hook script could not be written.`
          : operation === "backup"
            ? `${name} hook config backup could not be written.`
            : `${name} hook config could not be written.`,
      { cause },
    );
  });
}

/** True when the artifact is owned by another launcher, or by an owner Station cannot read. */
export function isHookOwnershipConflict(
  ownership: ProviderHookArtifactOwnership | undefined,
): ownership is Extract<
  ProviderHookArtifactOwnership,
  { status: "different-owner" | "unknown-owner" }
> {
  return ownership?.status === "different-owner" || ownership?.status === "unknown-owner";
}
