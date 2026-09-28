---
"catherd-cli": patch
---

The runs page now counts a live role's elapsed time and a run's age in wall-clock time. It had shown 00:00 for every
running role, because OpenTUI's clock counts from process start. Workspace-write workers can now write the
toolchain caches that exist (Go build and module caches, the pnpm store, Bun's install cache, npm's cache), so a
sandboxed `go vet` no longer fails with "operation not permitted" or starts cold in every lane.
