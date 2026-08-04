import { setupMessageCatalog } from "./catalog.js";
import type {
  SetupMessageArguments,
  SetupMessageId,
  SetupMessageRef,
  SetupMessageRefFor,
  SetupMessageVariant,
} from "./types.js";

type SetupMessageIdWithoutArguments = {
  [Id in SetupMessageId]: SetupMessageArguments[Id] extends undefined ? Id : never;
}[SetupMessageId];

type SetupMessageIdWithArguments = Exclude<SetupMessageId, SetupMessageIdWithoutArguments>;

export function setupMessageRef<Id extends SetupMessageIdWithoutArguments>(
  id: Id,
): SetupMessageRefFor<Id>;
export function setupMessageRef<Id extends SetupMessageIdWithArguments>(
  id: Id,
  args: SetupMessageArguments[Id],
): SetupMessageRefFor<Id>;
export function setupMessageRef(
  id: SetupMessageId,
  args?: SetupMessageArguments[SetupMessageIdWithArguments],
): SetupMessageRef {
  if (args === undefined) return { id } as SetupMessageRef;
  return { id, args } as SetupMessageRef;
}

export function resolveSetupMessage(
  ref: SetupMessageRef,
  variant: SetupMessageVariant = "terminal",
): string {
  const definition: { readonly terminal: string; readonly graphical?: string } | undefined =
    setupMessageCatalog[ref.id];
  if (definition === undefined) {
    throw new Error(`Unknown setup message: ${String(ref.id)}`);
  }
  const template =
    variant === "graphical" ? (definition.graphical ?? definition.terminal) : definition.terminal;
  const args: Readonly<Record<string, string | number>> = "args" in ref ? ref.args : emptyArguments;
  return template.replaceAll(messageArgumentPattern, (_placeholder, name: string) => {
    const value = args[name];
    if (value === undefined) {
      throw new Error(`Missing setup message argument ${name} for ${ref.id}.`);
    }
    return String(value);
  });
}

const emptyArguments: Readonly<Record<string, string | number>> = Object.freeze({});
const messageArgumentPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
