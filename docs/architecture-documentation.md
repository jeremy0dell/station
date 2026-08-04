# Architecture Documentation

Status: adopted living standard for Observer architectural declarations.

This standard applies to `apps/observer` and to declarations in immediate
contracts, protocol, CLI composition, and integrations when they participate in
an Observer seam. It does not automatically classify the Station UI, client,
host, or unrelated packages; another subsystem may adopt it through an explicit
architecture decision.

Use this document when adding or materially changing an Observer application
port, adapter entrypoint, use case, shared policy, or composition root. It
defines the small JSDoc language that makes those seams recognizable in source.

This document does not define the Observer's boundaries, flows, or known
deviations. See [Observer Architecture](observer-architecture.md) for those
decisions and [Architecture](architecture.md) for the repository-wide system
map. Ordinary code comments are outside this marker standard and should remain
concise, preserving only load-bearing intent.

## Controlled Roles

Architectural declarations use exactly one of these first-line markers:

| Marker | Meaning |
| --- | --- |
| `DRIVING PORT` | An application-owned contract through which an external actor requests application behavior. |
| `DRIVEN PORT` | An application-owned capability contract that a use case calls to reach an external actor. |
| `ADAPTER` | A boundary implementation that translates between application terms and an external actor or representation. |
| `USE CASE` | An application operation that realizes one product intent, coordinating policies and ports as needed. |
| `POLICY` | A reusable, deterministic, IO-free product decision. |
| `COMPOSITION ROOT` | An entrypoint that chooses concrete adapters and owns their wiring or lifecycle. |

These roles describe dependency direction, not folders or naming suffixes:

```text
external actor
    -> driving adapter -> DRIVING PORT -> USE CASE -> POLICY
                                               |
                                               v
                                          DRIVEN PORT -> ADAPTER -> external actor

                     COMPOSITION ROOT wires concrete roles
```

The vocabulary is deliberately small. `Provider`, `Repository`, `Service`,
`Model`, and `Component` are not architectural markers. They may remain useful
domain or implementation names: `StationTerminalProvider`, for example, is an
`ADAPTER`, while `ManagedTerminalLifecycle` is a `DRIVEN PORT`.

Commands, queries, events, snapshots, entities, value objects, schemas, DTOs,
and workers are also meaningful concepts rather than additional roles. Classify
their architectural entrypoint with one of the six roles when applicable; leave
ordinary declarations unmarked.

## Exact JSDoc Form

Put the marker on the declaration's first nonblank JSDoc line, followed by a
blank JSDoc line and one concise application-purpose paragraph:

```ts
/**
 * ROLE
 *
 * States the application purpose in plain language.
 *
 * Optionally records only load-bearing authority, identity, ordering,
 * idempotency, lifecycle, cancellation, or failure semantics.
 */
export interface NamedArchitecturalDeclaration {
  // ...
}
```

The grammar is:

1. Use a multiline `/** ... */` JSDoc block immediately before a named,
   top-level exported production declaration.
2. Make the first content line exactly one controlled marker, including case and
   spacing. Do not write `Adapter`, `[ADAPTER]`, `ADAPTER:`, or combined roles.
3. Put a blank JSDoc line immediately after the marker.
4. Follow with one short paragraph that explains what the application gains
   from the seam, rather than restating the declaration name or TypeScript type.
5. Add further prose only when it protects a stable boundary rule. Normal
   JSDoc tags, when needed, come after the prose.

Do not add a metadata mini-language such as `Purpose:`, `Owner:`, `Direction:`,
`Implements:`, or `Composed by:`. The prose should remain readable without a
parser, while structured ownership and adapter mappings belong in the canonical
architecture document.

One declaration has one role. If a declaration can only be explained with two
markers, split its responsibilities or record an explicit deviation; do not
write `USE CASE / ADAPTER`.

## Where Markers Apply

Mark the exported declaration that forms a consequential architectural seam:

- an application-owned driving or driven port;
- the public class, object, or factory that implements an adapter boundary;
- an application entrypoint that owns a complete use case;
- a shared policy reused across use cases or clients;
- an entrypoint that selects concrete implementations or owns their lifecycle.

Do not mark:

- schemas, DTOs, errors, value types, constants, or data-only records;
- ordinary helpers, selectors, mappers, or formatters;
- every method on a marked port or adapter;
- adapter-private parsers, command runners, and representation types;
- tests, fixtures, fakes, and test builders;
- UI components or hooks merely because they are exported;
- pure `index.ts` barrels or module-wide comments.

An `index.ts` or `types.ts` filename carries no architectural meaning. A pure
barrel stays unmarked. When an `index.ts` contains a real architectural
entrypoint, mark its declaration; move the behavior to a purpose-named module
only when that improves ownership or navigation.

Use this quick classification check:

1. Does an outside actor enter the application through this contract? `DRIVING
   PORT`.
2. Does application behavior call this contract to reach outward? `DRIVEN
   PORT`.
3. Does this implementation translate at either boundary? `ADAPTER`.
4. Does this operation coordinate a complete application intent? `USE CASE`.
5. Is this a reusable deterministic product decision with no IO? `POLICY`.
6. Does this entrypoint choose concrete implementations or own their lifecycle?
   `COMPOSITION ROOT`.
7. If none applies, leave it unmarked.

## Role Distinctions

### Port versus adapter

The application owns the port's vocabulary; an adapter implements or invokes
that conversation using outside mechanics. Mark both declarations when both
are public seams, each with its own role. Do not label an implementation as a
port merely because it satisfies an interface.

Current example:

- [`ManagedTerminalLifecycle`](../packages/contracts/src/providers.ts) is a
  `DRIVEN PORT` owned in application contracts.
- [`StationTerminalProvider`](../integrations/terminal/station/src/provider.ts)
  is an `ADAPTER` that implements it using Station terminal and host mechanics.

### Driving port versus use case

A driving port is the callable application contract. A use case is the
operation that fulfills an intent behind that contract. One driving port may
expose several use cases, and a use case may be called by more than one driving
adapter.

[`ObserverApi`](../packages/contracts/src/observer.ts) is the Observer `DRIVING
PORT`. Protocol client and server adapters translate between that
application-owned contract and NDJSON transport mechanics.

[`prepareExternalLaunch`](../apps/observer/src/runtime/externalLaunch.ts) and
[`reportExternalExit`](../apps/observer/src/runtime/externalLaunch.ts) are
current `USE CASE` examples. Their callers and transport wrappers are not part
of those use cases merely because they invoke them.

### Policy versus helper or use case

A policy expresses a product decision and can run without a database, socket,
filesystem, process, provider, clock, or logger. It is marked only when the
decision is a shared architectural seam, not merely because a helper is pure.

`worktreeHasLiveAgent` is an existing policy-shaped decision reused by Observer
commands, reconciliation, external launch, and dashboard behavior. It is a
candidate for the first `POLICY` marker when that declaration is materially
touched; this document does not require an unrelated backfill edit.

A function that coordinates a policy with persistence or provider calls is a
`USE CASE`, even if most of its calculations are pure.

### Adapter versus composition root

An adapter performs boundary translation at runtime. A composition root chooses
which concrete adapters occupy application roles and wires their lifecycles.
Constructors and factories are not automatically composition roots.

[`createProviderRegistry`](../apps/cli/src/observerProviders.ts) is a current
`COMPOSITION ROOT`: it chooses concrete provider integrations and supplies
their application roles. Constructing an internal helper or returning a use
case closure without choosing concrete boundary implementations is not
composition.

## Adoption on Touch

Adopt the language seam by seam instead of performing a comment-only backfill:

- New architectural seams must use the marker when introduced.
- A materially changed existing seam gains or corrects its marker in the same
  change. Material changes include responsibility, dependency direction,
  application contract, external actor, authority, identity, lifecycle, or
  failure semantics.
- Formatting, private refactoring, and behavior fixes that do not change the
  seam do not force a marker-only edit.
- When a remediation stage classifies or moves a group of seams, add that group
  to architecture diagnostics together rather than sweeping unrelated areas.
- An unmarked legacy seam is staged migration work, not evidence that the
  vocabulary is optional. The seam inventory tracks marker coverage; the
  architecture deviation register is reserved for consequential boundary
  violations.

If a touched declaration does not fit one role honestly, do not choose the
nearest-sounding word. Split mixed ownership when the change permits it, or
record the deviation and exit condition in
[Observer Architecture](observer-architecture.md).

## Generated Manifest And Dependency Gate

Run the source-derived Observer architecture tooling from the repository root:

```bash
pnpm architecture:observer:generate
pnpm architecture:observer:check
```

Generation validates first and then atomically writes
`docs/generated/observer-architecture-manifest.json`. Check mode rebuilds the
same bytes in memory and fails when the committed artifact is stale. The
manifest inventories every Observer production module and named export. An
ordinary or not-yet-adopted export appears with `role: null`; that is review
information, not a failure and not permission to guess a role.

The checker validates the exact marker grammar, attachment, purpose paragraph,
source inventory, module resolution, source cycles, package boundaries, and
declaration-level role direction. Diagnostics identify the source declaration,
role, runtime or type-only edge, resolved target declaration and role, violated
rule, and corrective action. Runtime and type-only imports, re-exports, barrels,
workspace aliases, import-equals, and literal dynamic edges all participate.

Dependencies between controlled declarations follow this table:

| Importing role | Allowed controlled targets |
| --- | --- |
| `DRIVING PORT` | `DRIVING PORT` |
| `DRIVEN PORT` | `DRIVEN PORT` |
| `POLICY` | `POLICY` |
| `USE CASE` | `USE CASE`, `POLICY`, `DRIVEN PORT` |
| `ADAPTER` | `ADAPTER`, `DRIVING PORT`, `DRIVEN PORT`, `POLICY` |
| `COMPOSITION ROOT` | all six controlled roles |

A use-case function declaration may name a same-module driving port as its return type when the function is the implementation offered through that port. This declared-return relationship documents conformance rather than an inward call from application behavior; parameters, local references, imports, and cross-module returns remain subject to the table.

The table applies to every controlled production declaration that participates in
an Observer seam, including declarations in CLI composition, contracts, protocol,
and integrations; it is not limited to declarations under `apps/observer/src`.
No controlled non-composition declaration may depend on a composition root. A
composition marker is not a file-wide exemption: the checker follows only
same-file private helpers reachable from the marked root and attributes that
wiring to the root. An unrelated export in the same file remains subject to its
own role.

## Enforcement Limits

The source-derived manifest defines marked coverage; it does not claim that
every legacy seam is already marked. Marker absence remains adoption-on-touch
and review territory, while malformed or orphan markers fail. Do not force an
ordinary export into a role to eliminate `role: null`, and do not maintain a
parallel role registry or editable exception map.

Automation cannot prove that a role is truthful, a purpose paragraph is
accurate, a policy is free of hidden IO, an adapter is substitutable, or
application code is semantically provider-neutral. Dependency checks, pure
policy tests, deliberately different fakes, port contract suites, adapter
integration tests, composition tests, and review provide that evidence. Do not
add prose lint or force ordinary exports into roles merely to make the marker
count look complete.

## Extending the Vocabulary

Treat the six markers as a closed vocabulary. Add a role only when a recurring,
consequential dependency responsibility cannot be described truthfully by an
existing role. A domain noun, file pattern, or one-off implementation shape is
not sufficient.

The same change that adds a role must:

1. define its dependency meaning and distinguish it from all existing roles;
2. state which declarations require it and which similar declarations do not;
3. show at least one real Station seam that needs it;
4. update this document, the canonical subsystem architecture where relevant,
   and the architecture diagnostic vocabulary;
5. migrate the motivating declaration without introducing aliases for an
   existing marker.

Do not introduce a new all-caps marker in source first and document it later.
