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

Closure-check script:

```bash
python3 - <<'PY'
import pathlib, re, subprocess

repo = pathlib.Path('.').resolve()
tracked = [
    pathlib.Path(p) for p in subprocess.check_output(
        ["git", "ls-files", "src/protocol/app-server-protocol"], text=True
    ).splitlines() if p.endswith('.ts')
]
changed = set(
    pathlib.Path(p) for p in subprocess.check_output(
        ["git", "diff", "--name-only"], text=True
    ).splitlines() if p.startswith("src/protocol/app-server-protocol/") and p.endswith('.ts')
)
roots = list(changed or tracked)
import_re = re.compile(r'^import type .* from "(\\./|\\.\\./)([^"]+)";', re.M)
missing, seen, stack = set(), set(), roots[:]
tracked_set = set(tracked)

while stack:
    rel = stack.pop()
    f = (repo / rel).resolve()
    if rel in seen or not f.exists():
        continue
    seen.add(rel)
    text = f.read_text(encoding='utf-8')
    for m in import_re.finditer(text):
        dep = (f.parent / (m.group(1) + m.group(2))).with_suffix('.ts').resolve()
        dep_rel = dep.relative_to(repo)
        if dep_rel not in tracked_set:
            missing.add(dep_rel)
        stack.append(dep_rel)

for p in sorted(missing):
    print(p)
PY
```

Then force-add missing generated files:

```bash
git add -f <each-missing-generated-file>
```

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
