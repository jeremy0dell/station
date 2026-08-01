import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type CorpusFreeze,
  CorpusFreezeSchema,
  type CorpusManifest,
  CorpusManifestSchema,
  type Gold,
  GoldSchema,
  type IncidentManifestEntry,
  type Provenance,
  ProvenanceSchema,
  type RedactionReport,
  RedactionReportSchema,
  type Replay,
  ReplaySchema,
} from "./protocol.js";

export const frozenBaseCommit = "3399a48f3e084b51dc28852b200703169ada1fcd";
export const frozenCandidateCommit = "890e8522f919fbdb3f47019f334614ad6434c0b4";

export const privateCorpusFileNames = [
  "gold.json",
  "provenance.json",
  "redaction-report.json",
] as const;

export type IncidentPackage = {
  entry: IncidentManifestEntry;
  root: string;
  symptom: string;
  replay: Replay;
  gold: Gold;
  provenance: Provenance;
  redactionReport: RedactionReport;
};

export type LoadedCorpus = {
  root: string;
  manifest: CorpusManifest;
  freeze: CorpusFreeze;
  incidents: IncidentPackage[];
};

export type PreparedEvidence = {
  root: string;
  evidenceSha256: string;
  copiedPaths: string[];
};

export async function loadSealedCorpus(corpusRoot: string): Promise<LoadedCorpus> {
  const root = await canonicalDirectory(corpusRoot, "corpus root");
  const manifestPath = join(root, "manifest.json");
  const freezePath = join(root, "freeze.json");
  const manifest = CorpusManifestSchema.parse(await readJson(manifestPath));
  const freeze = CorpusFreezeSchema.parse(await readJson(freezePath));

  if (
    freeze.baseCommit !== manifest.baseCommit ||
    freeze.candidateCommit !== manifest.candidateCommit
  ) {
    throw new Error("Corpus freeze commit identities do not match the manifest.");
  }
  if (freeze.manifestSha256 !== (await sha256File(manifestPath))) {
    throw new Error("Corpus manifest hash does not match freeze.json.");
  }

  if (
    manifest.baseCommit !== frozenBaseCommit ||
    manifest.candidateCommit !== frozenCandidateCommit
  ) {
    throw new Error("Corpus does not use the preregistered frozen base and candidate commits.");
  }
  if (Date.parse(freeze.candidateFrozenAt) > Date.parse(freeze.corpusSelectedAt)) {
    throw new Error("Candidate freeze must precede corpus selection.");
  }

  const incidents: IncidentPackage[] = [];
  for (const entry of manifest.incidents) {
    incidents.push(await loadIncidentPackage(root, entry));
  }

  const heldOutEntries = incidents.filter((incident) => incident.entry.cohort === "held-out");
  const heldOutIds = heldOutEntries.map((incident) => incident.entry.id).sort();
  if (JSON.stringify(heldOutIds) !== JSON.stringify([...freeze.heldOutIncidentIds].sort())) {
    throw new Error("Held-out incident IDs do not match the sealed freeze record.");
  }
  if (freeze.heldOutCorpusSha256 !== (await sha256IncidentPackages(heldOutEntries))) {
    throw new Error("Held-out corpus hash does not match freeze.json.");
  }

  return { root, manifest, freeze, incidents };
}

export function assertStudyComposition(corpus: LoadedCorpus): void {
  const development = corpus.incidents.filter(
    (incident) => incident.entry.cohort === "development",
  );
  const heldOut = corpus.incidents.filter((incident) => incident.entry.cohort === "held-out");
  if (development.length !== 6 || heldOut.length !== 24) {
    throw new Error(
      `Expected 6 development and 24 held-out incidents; found ${development.length} and ${heldOut.length}.`,
    );
  }

  const areaCounts = new Map<string, number>();
  for (const incident of heldOut) {
    areaCounts.set(incident.entry.area, (areaCounts.get(incident.entry.area) ?? 0) + 1);
  }
  const expectedAreaCounts = new Map([
    ["configuration-startup", 3],
    ["observer-lifecycle-socket", 3],
    ["provider-operation-boundaries", 3],
    ["provider-hooks-ingress", 3],
    ["command-trace-correlation", 3],
    ["persistence-retention", 3],
    ["terminal-tui-runtime", 3],
    ["reports-evidence-adequacy", 3],
  ]);
  for (const [area, expected] of expectedAreaCounts) {
    if (areaCounts.get(area) !== expected) {
      throw new Error(`Expected exactly ${expected} held-out incidents in ${area}.`);
    }
  }

  const exactIds = corpus.incidents.filter((incident) => incident.entry.hasExactId).length;
  const noRetainedIds = corpus.incidents.filter((incident) => !incident.entry.hasRetainedId).length;
  const explicitUnknownUnderlyingCause = corpus.incidents.filter(
    (incident) => incident.gold.underlyingCauseDisposition === "unknown",
  ).length;
  const conclusiveProximateDisposition = corpus.incidents.filter(
    (incident) => incident.entry.correctDisposition === "success",
  ).length;
  if (
    exactIds < 5 ||
    noRetainedIds < 6 ||
    explicitUnknownUnderlyingCause < 4 ||
    conclusiveProximateDisposition < 4
  ) {
    throw new Error("Corpus does not meet the required incident cross-cutting distribution.");
  }
}

export async function prepareTrialEvidence(input: {
  incident: IncidentPackage;
  workspaceRoot: string;
}): Promise<PreparedEvidence> {
  const targetRoot = resolve(input.workspaceRoot);
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const sourceRoot = input.incident.root;
  const sourceRealRoot = await canonicalDirectory(sourceRoot, "incident package");
  const copiedPaths = ["symptom.txt", "replay.json", ...input.incident.replay.evidencePaths];

  for (const copiedPath of copiedPaths) {
    const sourcePath = await safeExistingPath(sourceRealRoot, copiedPath);
    const destinationPath = await safeDestinationPath(targetRoot, copiedPath);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await cp(sourcePath, destinationPath, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    await assertTreeHasNoSymlink(destinationPath);
  }

  await assertNoPrivateCorpusFiles(targetRoot);
  const evidenceSha256 = await sha256Tree(targetRoot);
  return { root: targetRoot, evidenceSha256, copiedPaths };
}

export async function assertNoPrivateCorpusFiles(workspaceRoot: string): Promise<void> {
  for (const name of privateCorpusFileNames) {
    const leaked = await findFileNamed(workspaceRoot, name);
    if (leaked !== undefined) {
      throw new Error(
        `Private corpus file leaked into trial workspace: ${relative(workspaceRoot, leaked)}`,
      );
    }
  }
}

export async function assertNoPrivateLabelLeakage(
  workspaceRoot: string,
  privateLabels: readonly string[],
): Promise<void> {
  const files = await regularFiles(workspaceRoot);
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const label of privateLabels) {
      if (label.length > 0 && content.includes(label)) {
        throw new Error(`Private corpus label leaked into trial workspace: ${basename(file)}`);
      }
    }
  }
}

export async function sha256File(filePath: string): Promise<string> {
  await assertRegularFile(filePath);
  return sha256(await readFile(filePath));
}

export async function sha256Tree(root: string): Promise<string> {
  const rootRealPath = await canonicalDirectory(root, "tree root");
  const files = await regularFiles(rootRealPath);
  const hash = createHash("sha256");
  for (const file of files) {
    const name = relative(rootRealPath, file).split(sep).join("/");
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function loadIncidentPackage(
  corpusRoot: string,
  entry: IncidentManifestEntry,
): Promise<IncidentPackage> {
  const root = await safeExistingPath(corpusRoot, join("incidents", entry.id));
  const symptomPath = await safeExistingPath(root, "symptom.txt");
  const replayPath = await safeExistingPath(root, "replay.json");
  const packageSha256 = await sha256Tree(root);
  if (packageSha256 !== entry.packageSha256) {
    throw new Error(`Incident package hash does not match manifest for ${entry.id}.`);
  }
  if ((await sha256File(symptomPath)) !== entry.symptomSha256) {
    throw new Error(`Incident symptom hash does not match manifest for ${entry.id}.`);
  }

  const replay = ReplaySchema.parse(await readJson(replayPath));
  if (replay.kind !== entry.replayKind) {
    throw new Error(`Incident replay kind does not match manifest for ${entry.id}.`);
  }
  for (const evidencePath of replay.evidencePaths) {
    await safeExistingPath(root, evidencePath);
  }

  return {
    entry,
    root,
    symptom: await readFile(symptomPath, "utf8"),
    replay,
    gold: GoldSchema.parse(await readJson(await safeExistingPath(root, "gold.json"))),
    provenance: ProvenanceSchema.parse(
      await readJson(await safeExistingPath(root, "provenance.json")),
    ),
    redactionReport: RedactionReportSchema.parse(
      await readJson(await safeExistingPath(root, "redaction-report.json")),
    ),
  };
}

async function sha256IncidentPackages(incidents: IncidentPackage[]): Promise<string> {
  const hash = createHash("sha256");
  for (const incident of [...incidents].sort((left, right) =>
    left.entry.id.localeCompare(right.entry.id),
  )) {
    hash.update(incident.entry.id);
    hash.update("\0");
    hash.update(await sha256Tree(incident.root));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function safeExistingPath(root: string, child: string): Promise<string> {
  const target = resolve(root, child);
  assertWithin(root, target);
  const targetRealPath = await realpath(target).catch(() => {
    throw new Error(`Required corpus path does not exist: ${child}`);
  });
  assertWithin(root, targetRealPath);
  await assertTreeHasNoSymlink(target);
  return target;
}

async function safeDestinationPath(root: string, child: string): Promise<string> {
  const target = resolve(root, child);
  assertWithin(root, target);
  return target;
}

function assertWithin(root: string, candidate: string): void {
  const pathRelative = relative(root, candidate);
  if (
    pathRelative === "" ||
    (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !pathRelative.startsWith("/"))
  ) {
    return;
  }
  throw new Error(`Corpus path escapes its root: ${candidate}`);
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const stats = await lstat(path).catch(() => {
    throw new Error(`Missing ${label}: ${path}`);
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`);
  }
  return realpath(path);
}

async function assertRegularFile(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => {
    throw new Error(`Missing required file: ${path}`);
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Expected a regular non-symlink file: ${path}`);
  }
}

async function assertTreeHasNoSymlink(root: string): Promise<void> {
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) {
    throw new Error(`Symlinks are forbidden in corpus evidence: ${root}`);
  }
  if (!stats.isDirectory()) {
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await assertTreeHasNoSymlink(join(root, entry.name));
  }
}

async function regularFiles(root: string): Promise<string[]> {
  await assertTreeHasNoSymlink(root);
  const output: string[] = [];
  await collectRegularFiles(root, output);
  return output.sort();
}

async function collectRegularFiles(root: string, output: string[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectRegularFiles(path, output);
    } else if (entry.isFile()) {
      output.push(path);
    } else {
      throw new Error(`Unsupported corpus file type: ${path}`);
    }
  }
}

async function findFileNamed(root: string, name: string): Promise<string | undefined> {
  for (const file of await regularFiles(root)) {
    if (basename(file) === name) {
      return file;
    }
  }
  return undefined;
}
