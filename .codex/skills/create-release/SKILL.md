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

## Step 3 — Gather changelog content

- List merged PRs between the two tags:
  ```
  gh pr list --state merged --search "merged:>=$(gh release view $PREV --json publishedAt -q .publishedAt | cut -dT -f1)" --json number,title,labels
  ```
- Also review the commit log for any direct-push changes not covered by PRs:
  ```
  git log $PREV..$TAG --oneline --no-merges
  ```
- Categorise each change into: **Breaking Changes**, **New Features**, **Bug Fixes**, **Under the Hood**, or **Documentation**. Use PR labels and titles as hints. Omit empty sections.

## Step 4 — Build release notes

- Read the template at `.github/RELEASE_NOTES_TEMPLATE.md`.
- Derive the repo slug dynamically: `gh repo view --json nameWithOwner -q .nameWithOwner`.
- Fill in the template, replacing `[VERSION]`, `[PREV]`, the repo URL, and each section's placeholder with the categorised changes. Include PR numbers as `(#N)` links.
- Omit any section (including Migration Guide) that has no content.

## Step 5 — Create the release

- Create the release:
  ```
  gh release create <tag> --title "v<VERSION>" --notes "<filled-in notes>"
  ```
- Show the user the release URL from the output.
