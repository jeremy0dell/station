import type { ProviderHookArtifactOwnership } from "@station/contracts";
import {
  createHookSetupFileOps,
  type HookSetupErrorFactory,
  type HookSetupFileOps,
} from "@station/runtime";

type HookSetupOperation = Parameters<HookSetupErrorFactory>[0]["operation"];

export type HookSetupErrorClass<TCode extends string> = new (
  code: TCode,
  message: string,
  options?: { cause?: unknown },
) => Error & { readonly tag: string; readonly code: TCode; readonly provider: string };

/** `tag` doubles as the non-enumerable `name`, and the message is not code-prefixed, unlike
 * the harness provider errors. */
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

/** `removeTarget` exists because Claude removes a settings artifact where Codex and Cursor
 * remove only the script. */
export function hookSetupFileOpsFor<TCode extends string>(
  ErrorClass: HookSetupErrorClass<TCode>,
  codes: { unreadable: TCode; writeFailed: TCode },
  labels: { displayName: string; removeTarget: "file" | "script" },
): HookSetupFileOps {
  const name = labels.displayName;
  const failures: Record<HookSetupOperation, { code: TCode; message: string }> = {
    read: { code: codes.unreadable, message: `${name} hook config could not be read.` },
    metadata: {
      code: codes.unreadable,
      message: `${name} hook config metadata could not be read.`,
    },
    remove: {
      code: codes.writeFailed,
      message: `${name} hook ${labels.removeTarget} could not be removed.`,
    },
    writeScript: { code: codes.writeFailed, message: `${name} hook script could not be written.` },
    backup: {
      code: codes.writeFailed,
      message: `${name} hook config backup could not be written.`,
    },
    writeConfig: { code: codes.writeFailed, message: `${name} hook config could not be written.` },
  };
  return createHookSetupFileOps(({ operation, cause }) => {
    const failure = failures[operation];
    return new ErrorClass(failure.code, failure.message, { cause });
  });
}

export function isHookOwnershipConflict(
  ownership: ProviderHookArtifactOwnership | undefined,
): ownership is Extract<
  ProviderHookArtifactOwnership,
  { status: "different-owner" | "unknown-owner" }
> {
  return ownership?.status === "different-owner" || ownership?.status === "unknown-owner";
}
