import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import { z } from "zod";
import { updateErrorFromUnknown } from "./updateError.js";

const repository = "jeremy0dell/station";
const apiBaseUrl = `https://api.github.com/repos/${repository}/releases`;
const downloadBaseUrl = `https://github.com/${repository}/releases/download`;
const apiResponseMaxBytes = 4 * 1024 * 1024;
const releasesPerPage = 100;
const maximumReleasePages = 10;
const githubEnvironment = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "STATION_INSTALL_RELEASE_ID",
] as const;
const releaseTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const ReleaseTimestampSchema = z.string().datetime({ offset: true });

const nativeBinaryTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

export type NativeBinaryTarget = (typeof nativeBinaryTargets)[number];

type NativeReleaseAsset = {
  name: string;
  url: string;
};

export type NativeBinaryRelease = {
  tag: string;
  version: string;
  releaseId: number;
  publishedAt: string;
  assets: {
    installer: NativeReleaseAsset;
    checksums: NativeReleaseAsset;
    archive: Record<NativeBinaryTarget, NativeReleaseAsset>;
  };
};

type NativeReleaseResolution = {
  current: NativeBinaryRelease;
  latest: NativeBinaryRelease;
};

/** Resolves the installed release and newest usable Station native release. */
export interface NativeReleaseDiscovery {
  resolve(input: { currentTag: string; signal?: AbortSignal }): Promise<NativeReleaseResolution>;
}

type GithubNativeReleaseDiscoveryDeps = {
  commandRunner?: ExternalCommandRunner;
};

const GithubAssetSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
  })
  .strip();

const GithubReleaseSchema = z
  .object({
    id: z.number().int().positive(),
    tag_name: z.string().min(1),
    draft: z.boolean(),
    immutable: z.boolean(),
    published_at: ReleaseTimestampSchema,
    assets: z.array(GithubAssetSchema).max(100),
  })
  .strip();

type GithubRelease = z.infer<typeof GithubReleaseSchema>;

/** Creates strict, bounded GitHub release discovery for the installer-binary channel. */
export function createGithubNativeReleaseDiscovery(
  deps: GithubNativeReleaseDiscoveryDeps = {},
): NativeReleaseDiscovery {
  const commandRunner = deps.commandRunner;
  return {
    async resolve(input) {
      const fetchOptions: { commandRunner?: ExternalCommandRunner; signal?: AbortSignal } = {};
      if (commandRunner !== undefined) fetchOptions.commandRunner = commandRunner;
      if (input.signal !== undefined) fetchOptions.signal = input.signal;

      let currentBody: string;
      let firstPageBody: string;
      try {
        [currentBody, firstPageBody] = await Promise.all([
          fetchGithubJson(
            `${apiBaseUrl}/tags/${encodeURIComponent(input.currentTag)}`,
            fetchOptions,
          ),
          fetchGithubJson(releasePageUrl(1), fetchOptions),
        ]);
      } catch (error) {
        throw updateErrorFromUnknown(error, {
          code: "UPDATE_RELEASE_DISCOVERY_FAILED",
          message: "Could not read Station release metadata.",
          hint: "Check the network connection and retry the update.",
        });
      }

      const current = parseCurrentRelease(currentBody, input.currentTag);
      const releases: GithubRelease[] = [];
      let page = 1;
      let pageBody = firstPageBody;
      while (true) {
        const pageValues = parseReleasePage(pageBody, page);
        for (const value of pageValues) {
          const candidate = GithubReleaseSchema.safeParse(value);
          if (candidate.success && isCompletePublishedRelease(candidate.data)) {
            releases.push(candidate.data);
          }
        }
        if (pageValues.length < releasesPerPage) break;
        if (page === maximumReleasePages) {
          throw releaseInvalid(
            `Station release discovery exceeded ${maximumReleasePages * releasesPerPage} releases.`,
          );
        }
        page += 1;
        try {
          pageBody = await fetchGithubJson(releasePageUrl(page), fetchOptions);
        } catch (error) {
          throw updateErrorFromUnknown(error, {
            code: "UPDATE_RELEASE_DISCOVERY_FAILED",
            message: `Could not read Station release metadata page ${page}.`,
            hint: "Check the network connection and retry the update.",
          });
        }
      }

      return { current, latest: selectLatestCompleteRelease(releases) };
    },
  };
}

function nativeReleaseAssets(tag: string): NativeBinaryRelease["assets"] {
  const version = releaseVersion(tag);
  const baseUrl = `${downloadBaseUrl}/${encodeURIComponent(tag)}`;
  const archive = Object.fromEntries(
    nativeBinaryTargets.map((target) => {
      const name = `stn-v${version}-${target}.tar.gz`;
      return [target, { name, url: `${baseUrl}/${name}` }];
    }),
  ) as Record<NativeBinaryTarget, NativeReleaseAsset>;
  return {
    installer: { name: "install.sh", url: `${baseUrl}/install.sh` },
    checksums: { name: "SHA256SUMS", url: `${baseUrl}/SHA256SUMS` },
    archive,
  };
}

export function releaseVersion(tag: string): string {
  const match = releaseTagPattern.exec(tag);
  if (match === null || hasInvalidNumericPrerelease(match[4])) {
    throw releaseInvalid(`Station release tag '${tag}' is not valid release SemVer.`);
  }
  return tag.slice(1);
}

export function isCanonicalNativeRelease(release: NativeBinaryRelease): boolean {
  try {
    if (release.version !== releaseVersion(release.tag)) return false;
    if (!Number.isSafeInteger(release.releaseId) || release.releaseId <= 0) return false;
    if (!ReleaseTimestampSchema.safeParse(release.publishedAt).success) return false;
    const expected = nativeReleaseAssets(release.tag);
    if (!sameAsset(release.assets.installer, expected.installer)) return false;
    if (!sameAsset(release.assets.checksums, expected.checksums)) return false;
    return nativeBinaryTargets.every((target) =>
      sameAsset(release.assets.archive[target], expected.archive[target]),
    );
  } catch {
    return false;
  }
}

function parseCurrentRelease(body: string, expectedTag: string): NativeBinaryRelease {
  const parsed = GithubReleaseSchema.safeParse(parseJson(body));
  if (!parsed.success) {
    throw releaseInvalid(
      "The installed Station version does not resolve to valid release metadata.",
    );
  }
  if (parsed.data.tag_name !== expectedTag || !isCompletePublishedRelease(parsed.data)) {
    throw releaseInvalid(
      `Installed Station version '${expectedTag}' is not a complete published immutable release.`,
    );
  }
  return nativeRelease(parsed.data);
}

function parseReleasePage(body: string, page: number): unknown[] {
  const parsed = z.array(z.unknown()).max(releasesPerPage).safeParse(parseJson(body));
  if (!parsed.success) {
    throw releaseInvalid(`Station release metadata page ${page} has an invalid shape.`);
  }
  return parsed.data;
}

function selectLatestCompleteRelease(releases: readonly GithubRelease[]): NativeBinaryRelease {
  let selected: GithubRelease | undefined;
  for (const release of releases) {
    if (selected === undefined || compareReleasePublication(release, selected) > 0) {
      selected = release;
    }
  }
  if (selected === undefined) {
    throw releaseInvalid("No complete published immutable Station binary release was found.");
  }
  return nativeRelease(selected);
}

function nativeRelease(release: GithubRelease): NativeBinaryRelease {
  return {
    tag: release.tag_name,
    version: releaseVersion(release.tag_name),
    releaseId: release.id,
    publishedAt: release.published_at,
    assets: nativeReleaseAssets(release.tag_name),
  };
}

function isCompletePublishedRelease(release: GithubRelease): boolean {
  if (release.draft || !release.immutable) return false;
  let expected: NativeBinaryRelease["assets"];
  try {
    expected = nativeReleaseAssets(release.tag_name);
  } catch {
    return false;
  }
  const expectedNames = [
    expected.checksums.name,
    expected.installer.name,
    ...nativeBinaryTargets.map((target) => expected.archive[target].name),
  ].sort();
  const actualNames = release.assets.map((asset) => asset.name).sort();
  return (
    new Set(actualNames).size === actualNames.length &&
    actualNames.length === expectedNames.length &&
    actualNames.every((name, index) => name === expectedNames[index])
  );
}

function compareReleasePublication(left: GithubRelease, right: GithubRelease): number {
  const timestampDifference = Date.parse(left.published_at) - Date.parse(right.published_at);
  return timestampDifference === 0 ? left.id - right.id : timestampDifference;
}

function sameAsset(left: NativeReleaseAsset, right: NativeReleaseAsset): boolean {
  return left.name === right.name && left.url === right.url;
}

async function fetchGithubJson(
  url: string,
  options: { commandRunner?: ExternalCommandRunner; signal?: AbortSignal },
): Promise<string> {
  const input = {
    command: "curl",
    args: [
      "--disable",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--tlsv1.2",
      "--max-filesize",
      String(apiResponseMaxBytes),
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
      url,
    ],
    unsetEnv: githubEnvironment,
    timeoutMs: 30_000,
    maxOutputChars: apiResponseMaxBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return (await runExternalCommand(input, options.commandRunner)).stdout;
}

function releasePageUrl(page: number): string {
  return `${apiBaseUrl}?per_page=${releasesPerPage}&page=${page}`;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_RELEASE_INVALID",
      message: "Station release metadata is not valid JSON.",
    });
  }
}

function hasInvalidNumericPrerelease(prerelease: string | undefined): boolean {
  return (
    prerelease
      ?.split(".")
      .some((identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier)) ?? false
  );
}

function releaseInvalid(message: string) {
  return updateErrorFromUnknown(undefined, {
    code: "UPDATE_RELEASE_INVALID",
    message,
    hint: "Wait for a complete Station release or install an exact known-good release manually.",
  });
}
