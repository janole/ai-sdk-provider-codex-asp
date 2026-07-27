---
name: create-release
description: Create a release for this repo on github.com
---

## Constraints

- Do NOT check npm or publish anything.
- Do NOT push commits or create pull requests.
- Do NOT create draft releases — publish directly.

## Step 1 — Resolve the tag

- The user should supply a tag in the form `vMAJOR.MINOR.PATCH` (e.g. `v0.4.0`).
- If no tag is supplied, find the latest tag with `git describe --tags --abbrev=0` and suggest the next patch bump. Ask the user to confirm or supply a different tag before proceeding.
- Verify the tag does not already exist on the remote: `gh release view <tag>`. If it exists, stop and tell the user.

## Step 2 — Determine the previous release

- Get the previous release tag: `gh release list --limit 1 --json tagName -q '.[0].tagName'`.
- Store both `TAG` (new) and `PREV` (previous) for use in later steps.
- `PREV` is the last *released* version, which is not always the previous *version tag* — releases can lag. If versions between `PREV` and `TAG` were never released, the notes must cover them too; say so in the summary line so the gap is not confusing later.
- Confirm the release will tag the intended commit: the work must be merged, `HEAD` should equal `origin/main`, and the tree should be clean.

## Step 3 — Gather changelog content

- List merged PRs between the two tags:
  ```
  gh pr list --state merged --search "merged:>=$(gh release view $PREV --json publishedAt -q .publishedAt | cut -dT -f1)" --json number,title,labels
  ```
- Always cross-check against the commit log, which is authoritative for what is actually in the range:
  ```
  git log $PREV..$TAG --oneline --no-merges
  ```
  The date search is only an approximation. A PR merged *after* `PREV` was published can still be an ancestor of `PREV` and therefore already released — if it does not appear in `git log $PREV..$TAG`, leave it out.
- Categorise each change into: **Breaking Changes**, **New Features**, **Bug Fixes**, **Under the Hood**, or **Documentation**. Use PR labels and titles as hints. Omit empty sections.

## Step 4 — Build release notes

- Read the template at `.github/RELEASE_NOTES_TEMPLATE.md`.
- Derive the repo slug dynamically: `gh repo view --json nameWithOwner -q .nameWithOwner`.
- Fill in the template, replacing `[VERSION]`, `[PREV]`, the repo URL, and each section's placeholder with the categorised changes. Include PR numbers as `(#N)` links.
- Omit any section (including Migration Guide) that has no content.

## Step 5 — Create the release

- Write the notes to a scratch file and pass `--notes-file`; long notes do not survive being inlined into `--notes`.
- Pass `--target` as a **full** SHA. A short SHA fails with `HTTP 422: Release.target_commitish is invalid`.
  ```
  gh release create <tag> --title "v<VERSION>" --target "$(git rev-parse HEAD)" --notes-file <scratch>/release-notes.md
  ```
- Show the user the release URL from the output.
- Verify: `gh release view <tag> --json tagName,isDraft,targetCommitish`.

## Step 6 — CHANGELOG

- `CHANGELOG.md` must carry an entry for the released version. Reuse the categorised content from Step 3 — condensed, no template scaffolding.
- Entries from `0.5.0` onwards are per release; older versions are grouped by minor series. Keep that shape.
- This skill must not push, and this repo's `main` is not to be committed to directly — so if the entry is missing, write it on a branch and tell the user it needs a PR. Do not treat the release as blocked on it.
