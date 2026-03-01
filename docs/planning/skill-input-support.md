# Skill Input Support

## What Are Skills?

Codex skills are reusable instruction sets (defined in SKILL.md files) that get
injected into the model's context when referenced. Think of them as `#include`
for AI instructions — a user references a skill by name+path, and Codex reads
the SKILL.md file and injects its contents as additional instructions for that turn.

Skills are scoped: `"user" | "repo" | "system" | "admin"`.

## How Skills Work in Codex (from source)

### Protocol

A skill is sent as a `UserInput` variant in the `turn/start` input array:

```ts
{ type: "skill", name: string, path: string }
```

- `name` — Skill identifier, used for dedup and telemetry
- `path` — Absolute path to the SKILL.md file on disk

### Processing Pipeline (codex-rs/core/src/skills/)

1. **No content conversion** — In `protocol/src/models.rs`, `UserInput::Skill`
   produces an empty content vec. Comment: *"Tool bodies are injected later in core"*

2. **Collection** (`collect_explicit_skill_mentions`):
   - Validates the path exists in the enabled skills list
   - Skips disabled or duplicate skills
   - Blocks the name from plain-text matching (prevents double injection)

3. **Injection** (`build_skill_injections`):
   - Reads the SKILL.md file contents from disk
   - Wraps content in a `SkillInstructions` response item
   - Resolves skill dependencies (MCP tools the skill needs via `SkillDependencies`)
   - Emits telemetry

4. **Result**: The model sees the skill's instructions as part of its system
   context for that turn.

### Skill Discovery

Codex provides RPC methods for skill discovery:

| Method | Params | Response |
|---|---|---|
| `skills/list` | `SkillsListParams` | `SkillsListResponse` → `SkillsListEntry[]` |
| `skills/remote/list` | `SkillsRemoteReadParams` | `SkillsRemoteReadResponse` |
| `skills/remote/export` | `SkillsRemoteWriteParams` | `SkillsRemoteWriteResponse` |
| `skills/config/write` | `SkillsConfigWriteParams` | `SkillsConfigWriteResponse` |

`SkillsListEntry` contains per-cwd skill metadata:
```ts
{ cwd: string, skills: SkillMetadata[], errors: SkillErrorInfo[] }
```

`SkillMetadata` is the full skill definition:
```ts
{
  name: string,
  description: string,
  shortDescription?: string,
  interface?: SkillInterface,      // displayName, iconSmall, iconLarge, brandColor, defaultPrompt
  dependencies?: SkillDependencies, // tools: SkillToolDependency[]
  path: string,                    // path to SKILL.md
  scope: SkillScope,               // "user" | "repo" | "system" | "admin"
  enabled: boolean,
}
```

### Skill Dependencies

Skills can declare tool dependencies (`SkillToolDependency`):
```ts
{
  type: string,        // e.g. "mcp"
  value: string,       // e.g. server name
  description?: string,
  transport?: string,  // e.g. "stdio"
  command?: string,    // e.g. "npx"
  url?: string,        // for HTTP-based tools
}
```

Codex resolves these at injection time (see `skill_dependencies.rs`).

## What We Have Today

- `CodexTurnInputSkill` type is exported but never constructed or sent
- No skill discovery API
- No way for users to reference skills in their prompts

## What to Implement

### Phase 1: Skill Input (turn/start)

Allow users to attach skills to a turn via provider options:

```ts
import { streamText } from "ai";

const result = streamText({
  model: codex("gpt-5.3-codex"),
  prompt: "Write a changelog for the latest release",
  providerOptions: {
    "codex-app-server": {
      skills: [
        { name: "changelog-writer", path: "/path/to/skills/changelog-writer/SKILL.md" },
      ],
    },
  },
});
```

**Implementation:**

1. **`src/model.ts`** — In `doStream()`, extract skills from `providerOptions`
   and prepend them as `{ type: "skill", name, path }` items in the
   `turn/start` input array (before the user's text input).

2. **`src/protocol/types.ts`** — `CodexTurnInputSkill` already exists as
   `Extract<UserInput, { type: "skill" }>`, which resolves to
   `{ type: "skill", name: string, path: string }`. No changes needed.

3. **Validation** — Verify `name` and `path` are non-empty strings. The path
   should be absolute (Codex expects a filesystem path to SKILL.md).

### Phase 2: Provider-Level Default Skills

Allow skills to be configured at the provider level so they're included in
every turn:

```ts
const codex = createCodexAppServer({
  skills: [
    { name: "code-review", path: "/home/user/.codex/skills/code-review/SKILL.md" },
  ],
});
```

**Implementation:**

1. **`src/provider-settings.ts`** — Add `skills` field:
   ```ts
   skills?: Array<{ name: string; path: string }>;
   ```

2. **`src/provider.ts`** — Wire through `resolvedSettings` (don't repeat the
   `emitPlanUpdates` bug!).

3. **`src/model.ts`** — Merge provider-level skills with per-call skills,
   dedup by name, and prepend to input array.

### Phase 3: Skill Discovery API

Expose `skills/list` as a method on the provider so users can discover
available skills programmatically:

```ts
const provider = createCodexAppServer({ ... });
const skills = await provider.listSkills({ cwds: ["/path/to/project"] });
// Returns: SkillsListEntry[]
```

**Implementation:**

1. Add `listSkills()` method to the provider that:
   - Spawns a temporary Codex connection (or uses the persistent pool)
   - Sends `skills/list` RPC with optional `SkillsListParams`
   - Returns the `SkillsListResponse.data` array
   - Disposes the connection

2. Export the relevant types: `SkillMetadata`, `SkillsListEntry`,
   `SkillInterface`, `SkillScope`, etc.

3. This enables building UIs that let users browse and select skills.

### Phase 4: Skill Discovery + Input Combined

With both phases above, enable a workflow like:

```ts
const provider = createCodexAppServer({ ... });

// Discover available skills
const entries = await provider.listSkills({ cwds: [process.cwd()] });
const allSkills = entries.flatMap(e => e.skills).filter(s => s.enabled);

// Let user pick skills, then use them
const result = streamText({
  model: provider("gpt-5.3-codex"),
  prompt: userPrompt,
  providerOptions: {
    "codex-app-server": {
      skills: allSkills.map(s => ({ name: s.name, path: s.path })),
    },
  },
});
```

## Files Reference

| File | Role |
|---|---|
| `src/model.ts` | Extract skills from providerOptions, prepend to turn input |
| `src/provider-settings.ts` | Add provider-level `skills` config |
| `src/provider.ts` | Wire `skills` through resolvedSettings, add `listSkills()` |
| `src/protocol/types.ts` | `CodexTurnInputSkill` already exists |
| `src/protocol/app-server-protocol/v2/UserInput.ts` | Generated: `{ type: "skill", name, path }` |
| `src/protocol/app-server-protocol/v2/SkillMetadata.ts` | Generated: full skill metadata |
| `src/protocol/app-server-protocol/v2/SkillsListParams.ts` | Generated: list params |
| `src/protocol/app-server-protocol/v2/SkillsListResponse.ts` | Generated: list response |

## Open Questions

- **Skill path resolution**: Should we support relative paths (resolved against
  `cwd`) or require absolute paths only?
- **Auto-discovery**: Should the provider automatically call `skills/list` on
  connect and make results available, or leave it fully manual?
- **Skill events**: Codex emits `skills_update_available` notifications. Should
  we surface these to the consumer?
- **Remote skills**: The protocol supports listing and downloading remote skills
  from a registry. Is this relevant for our use case?
