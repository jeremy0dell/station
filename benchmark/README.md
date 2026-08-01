# Benchmarks

This directory contains opt-in research infrastructure that is intentionally excluded from Station's ordinary CI and `test:all`.

`real-incident-debugging/` is the reusable, frozen-v13 A/B process for comparing a base CLI, a candidate CLI, and a raw-evidence arm on copied incident evidence. The committed fixture is synthetic. Private corpora, gold labels, review material, credentials, executable copies, model output, and study results must remain outside the repository.

Run deterministic harness tests with:

```bash
pnpm benchmark:typecheck
pnpm benchmark:real-incident-debugging
```

See [Real-incident debugging](real-incident-debugging/README.md) before preparing or running a study.
