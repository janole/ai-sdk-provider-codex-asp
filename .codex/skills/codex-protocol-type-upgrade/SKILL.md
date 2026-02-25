---
name: codex-protocol-type-upgrade
description: Upgrade and integrate regenerated Codex App Server Protocol TypeScript types in this repository with minimal risk. Use when codex version or generated protocol types changed, and ensure runtime mappings, tests, and tracked generated-file import closure are updated.
---

# Codex Protocol Type Upgrade

Follow this workflow when generated protocol files changed.

## Workflow

1. Regenerate and inspect generated diff.
2. Triage type changes: additive field vs new union variant vs breaking shape change.
3. Search runtime consumers in `src/` and adapt mappings/exhaustive switches.
4. Update focused tests that prove new context/variants are handled.
5. Ensure generated import closure for tracked files, force-adding missing generated dependencies.
6. Run `npm run typecheck` and relevant tests.
7. Commit with clear split between manual adaptation and generated dependency additions.

## Commands

```bash
npm run codex:generate-types
git diff --name-only | rg '^src/protocol/app-server-protocol/'
rg -n "TypeNameA|TypeNameB|TypeNameC" src tests
```

## Import Closure Rule (important)

Generated protocol directory is gitignored and we intentionally commit only used files. For every tracked generated file, all imported generated types it references (directly or transitively) must also be tracked.

Use the playbook for the closure-check script and force-add process:
- `docs/codex-protocol-type-upgrade-playbook.md`

## Validation

Always run:

```bash
npm run typecheck
```

Run focused tests for touched behavior (for approval changes, run `tests/approvals.test.ts`).

## Output expectations

Report:
- what changed in protocol surface
- what runtime behavior was adapted
- compatibility call (usually additive/backward compatible)
- caveats for exhaustive union consumers
