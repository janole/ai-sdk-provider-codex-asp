# Codex Protocol Type Upgrade Playbook

This playbook standardizes how we upgrade generated Codex App Server Protocol types while intentionally tracking only the subset we use.

## Scope

Use this when:
- `codex` was upgraded
- `npm run codex:generate-types` was run
- generated files in `src/protocol/app-server-protocol/` changed

Goal:
- keep runtime behavior correct
- avoid missing import dependencies in tracked generated files
- preserve backward compatibility where possible

## 1) Regenerate and inspect

```bash
npm run codex:generate-types
git status --short
```

Review changed generated files first:

```bash
git diff --name-only | rg '^src/protocol/app-server-protocol/'
```

## 2) Triage changes by risk

Classify each generated change:

- Additive field in object type: usually low risk
- New union variant: medium risk (can break exhaustive handling)
- Field changed from optional to required: high risk
- Renamed/removed field or variant: high risk

Search for runtime consumers in `src/`:

```bash
rg -n "TypeNameA|TypeNameB|TypeNameC" src tests
```

Focus on:
- approval handling (`src/approvals.ts`)
- event mapping/switches (`src/protocol/event-mapper.ts`)
- settings surface (`src/provider-settings.ts`, `src/protocol/types.ts`)

## 3) Adapt runtime code when needed

Typical required adaptation:
- forward new request context fields from protocol params to public callbacks
- update exhaustive `switch` or discriminated-union handling

Keep changes backward compatible:
- prefer adding optional fields in public request interfaces
- do not remove old fields unless protocol removal forces it

## 4) Update tests for new behavior

Add or update targeted tests, usually in:
- `tests/approvals.test.ts`
- mapper tests if event behavior changed

Minimum expectation:
- one test that proves newly added context is forwarded or handled

## 5) Ensure tracked generated files have import closure

Because generated folder is gitignored and we commit only used files, every tracked generated file must have its imported generated dependencies tracked too.

### 5.1 Build closure list (direct + transitive)

```bash
python3 - <<'PY'
import pathlib, re, subprocess

repo = pathlib.Path('.').resolve()
tracked = [
    pathlib.Path(p) for p in subprocess.check_output(
        ["git", "ls-files", "src/protocol/app-server-protocol"], text=True
    ).splitlines() if p.endswith('.ts')
]

# Optional: limit to changed generated files + whatever is already tracked.
changed = set(
    pathlib.Path(p) for p in subprocess.check_output(
        ["git", "diff", "--name-only"], text=True
    ).splitlines() if p.startswith("src/protocol/app-server-protocol/") and p.endswith('.ts')
)
roots = list(changed or tracked)

import_re = re.compile(r'^import type .* from "(\./|\.\./)([^"]+)";', re.M)
missing = set()
seen = set()
stack = roots[:]

tracked_set = set(tracked)

while stack:
    f = stack.pop()
    f = (repo / f).resolve()
    relf = f.relative_to(repo)
    if relf in seen or not f.exists():
        continue
    seen.add(relf)
    text = f.read_text(encoding='utf-8')
    for m in import_re.finditer(text):
        rel = m.group(1) + m.group(2)
        dep = (f.parent / rel).with_suffix('.ts').resolve()
        dep_rel = dep.relative_to(repo)
        if dep_rel not in tracked_set:
            missing.add(dep_rel)
        stack.append(dep_rel)

for p in sorted(missing):
    print(p)
PY
```

### 5.2 Force-add missing generated dependencies

```bash
git add -f <each-missing-generated-file>
```

Repeat closure check until empty.

## 6) Validate

```bash
npm run test -- tests/approvals.test.ts
npm run typecheck
```

Run broader `npm test` if event-mapper or model core was changed.

## 7) Commit strategy

Recommended split:
1. `chore: adapt provider to regenerated codex protocol types`
2. `chore: include generated type dependencies for tracked protocol files`

This keeps manual behavior changes separate from generated dependency additions.

## 8) Compatibility statement template

Use this in PR/release notes:

- Changes are mostly additive and backward compatible.
- Existing approval handlers continue to work.
- New protocol fields/variants are supported and optionally exposed.
- Caveat: external consumers with exhaustive union matching may need to add new cases.

## 9) Fast checklist

- [ ] Generated diff reviewed
- [ ] Union-variant additions triaged
- [ ] Runtime mappings updated (if needed)
- [ ] Tests updated for new behavior
- [ ] Missing generated import dependencies force-added
- [ ] `npm run typecheck` passes
- [ ] Focused tests pass
- [ ] Commit(s) created on `chore/...` branch
