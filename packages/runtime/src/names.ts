import { createHash } from "node:crypto";

export type StableNameProfile = "id" | "path-segment" | "tmux-window";
export type StableNameHashMode = "auto" | "always";

export type StableNameInput = {
  prefix?: string;
  profile: StableNameProfile;
  display: readonly string[];
  unique: readonly string[];
  maxLength?: number;
  hashLength?: number;
  hash?: StableNameHashMode;
};

type StableNameProfileOptions = {
  separator: string;
  fallback: string;
  defaultMaxLength: number;
  defaultHashLength: number;
  lowercase: boolean;
  allowed: RegExp;
};

const profiles: Record<StableNameProfile, StableNameProfileOptions> = {
  id: {
    separator: "_",
    fallback: "item",
    defaultMaxLength: 96,
    defaultHashLength: 10,
    lowercase: false,
    allowed: /[a-zA-Z0-9._:-]/,
  },
  "path-segment": {
    separator: "-",
    fallback: "item",
    defaultMaxLength: 96,
    defaultHashLength: 10,
    lowercase: true,
    allowed: /[a-zA-Z0-9._-]/,
  },
  "tmux-window": {
    separator: "-",
    fallback: "worktree",
    defaultMaxLength: 48,
    defaultHashLength: 10,
    lowercase: true,
    allowed: /[a-z0-9._-]/,
  },
};

export function stableName(input: StableNameInput): string {
  const profile = profiles[input.profile];
  const maxLength = input.maxLength ?? profile.defaultMaxLength;
  const hashLength = input.hashLength ?? profile.defaultHashLength;
  const hashMode = input.hash ?? "auto";
  const parts = input.prefix === undefined ? input.display : [input.prefix, ...input.display];
  const normalizedParts = parts.map((part) => normalizeNamePart(part, profile));
  const base =
    compactParts(
      normalizedParts.map((part) => part.value),
      profile.separator,
    ) || profile.fallback;
  const changed = normalizedParts.some((part) => part.changed);
  const needsHash =
    hashMode === "always" || (hashMode === "auto" && (changed || base.length > maxLength));

  if (!needsHash) {
    return truncateName(base, maxLength, profile.separator) || profile.fallback.slice(0, maxLength);
  }

  const hash = stableNameHash(input.unique, hashLength);
  const suffix = `${profile.separator}${hash}`;
  if (maxLength <= suffix.length) {
    return hash.slice(0, maxLength);
  }

  const head = truncateName(base, maxLength - suffix.length, profile.separator) || profile.fallback;
  return `${head}${suffix}`;
}

export function stableNameHash(parts: readonly string[], length = 10): string {
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part.normalize("NFC"))))
    .digest("hex")
    .slice(0, length);
}

function normalizeNamePart(
  value: string,
  profile: StableNameProfileOptions,
): { value: string; changed: boolean } {
  const raw = value.trim();
  const prepared = profile.lowercase ? raw.toLowerCase() : raw;
  const characters = Array.from(prepared, (character) =>
    profile.allowed.test(character) ? character : profile.separator,
  );
  const collapsed = collapseSeparators(characters.join(""), profile.separator);
  const trimmed = trimSeparators(collapsed, profile.separator);
  const normalized = trimmed.length === 0 ? profile.fallback : trimmed;
  return {
    value: normalized,
    changed: normalized !== raw,
  };
}

function compactParts(parts: readonly string[], separator: string): string {
  return trimSeparators(parts.filter((part) => part.length > 0).join(separator), separator);
}

function truncateName(value: string, maxLength: number, separator: string): string {
  if (value.length <= maxLength) {
    return value;
  }
  return trimSeparators(value.slice(0, maxLength), separator);
}

function collapseSeparators(value: string, separator: string): string {
  const escaped = escapeRegExp(separator);
  return value.replace(new RegExp(`${escaped}{2,}`, "g"), separator);
}

function trimSeparators(value: string, separator: string): string {
  const escaped = escapeRegExp(separator);
  return value.replace(new RegExp(`^${escaped}+|${escaped}+$`, "g"), "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
