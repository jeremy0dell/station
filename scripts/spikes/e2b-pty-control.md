# E2B PTY control experiment

This isolated module exercises PTY (pseudo-terminal) creation and attachment
control with an injected, descriptor-checked SDK facade. It has no E2B dependency,
credential lookup, real-mode command, sandbox provisioner, source uploader,
local-agent launcher, or Station runtime integration.

Run the offline checks with the repository's Node 24 and Bun 1.4.0 toolchain:

```sh
bun install --frozen-lockfile
node --check scripts/spikes/e2b-pty-control.mjs
bun run test:diagnostics -- tests/diagnostics/e2b-pty-control.test.ts
```

The diagnostic test runs in Station's shared machine sandbox and uses only fake
provider calls. The test also runs in the standard repository and hosted CI gates.
To obtain JSON results, append `--reporter=json --outputFile=/tmp/e2b-pty-check.json`
to the diagnostic command.

## Control rules

- One adapter instance attempts PTY creation at most once. A rejection or missing
  response consumes that attempt. An empty process list never authorizes another
  create. Recovery may attach only after exact process identity becomes observable.
- Sandbox and PTY validation failures revoke active and pending attachment
  authority before returning. Provider detach failure cannot restore that authority.
- Stop immediately invalidates the attachment generation, including queued requests,
  in-flight handshakes, returned pending handles, and activation waiting on output.
  The instance refuses further creation and attachment after Stop begins.
- Input and resize require the current active attachment. Local disconnect revokes
  only that attachment and leaves the remote PTY available for exact reattachment.
- Stop's `request_succeeded` means only that the injected kill request returned
  `true`. A `false`, malformed, or rejected result remains `request_uncertain`.
  Neither result proves process absence or sandbox release.
- Transport loss remains `transport_unproven`; it is not an authoritative PTY exit.

The module retains strict private schemas, bounded process/output parsing,
provider descriptor/accessor checks, exact execution/generation/nonce matching,
and deny-all sandbox validation. Its three-field configuration binds only the
fixture scope and timeout values. It is not account authorization or a spend limit.

## Evidence boundary

This module is an offline extraction from the PTY experiment associated with
[#741](https://github.com/jeremy0dell/station/issues/741). It is not a production
provider, a durable execution controller, or an accepted SDK integration.
The adapter instance must not be recreated to retry an uncertain create.
A future real composition must persist uncertainty before dispatch, serialize
execution ownership across processes, and recover the exact retained resource.
This module supplies none of that durable authority.

[#739](https://github.com/jeremy0dell/station/issues/739) owns real sandbox recovery
and cleanup; [#740](https://github.com/jeremy0dell/station/issues/740) owns exact
source materialization; #741 owns live PTY recovery and replay classification.
The later settlement correction on [#481](https://github.com/jeremy0dell/station/issues/481)
supersedes its old boolean contract. No replay taxonomy or production contract is
selected here. Historical normal-path runs do not establish failure recovery.

Users must provide their own E2B account, subscription, and current credentials.
Station does not bill for compute. Any real run requires explicit current account
and credential authorization, an isolated project/template, a bounded total spend,
a sandbox count and TTL, and an approved source/egress scope. Agent credentials
require separate authorization. Do not retrieve old chat credentials.

No Cloud option or marker appears in Station. Ordinary native and tmux presentation
remain unchanged. Manual verification of this deliverable is the offline command
above; it performs no PTY, sandbox, source, credential, or live Station mutation.
