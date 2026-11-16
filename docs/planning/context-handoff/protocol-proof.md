# Execution-context handoff: protocol proof

Evidence record for plan 004 `protocol-proof`: how a running Codex turn can move to another working directory, so that the new directory becomes the base directory for the rest of the session.

- **Adapter:** `0.5.8` (`main` at `9c44333`)
- **Codex:** `codex-cli 0.169.0` (live, logged in; no mocked RPC). Source read at tags `rust-v0.163.0` and `rust-v0.169.0` (`d32063f`).
- **Probe:** [`scripts/context-handoff-probe.ts`](../../../scripts/context-handoff-probe.ts). Sanitized wire logs: [`probe-run-0.169.0.txt`](probe-run-0.169.0.txt) (all scenarios), [`probe-run-0.169.0-apply-patch-pending-only-gate.txt`](probe-run-0.169.0-apply-patch-pending-only-gate.txt), [`probe-run-0.169.0-apply-patch.txt`](probe-run-0.169.0-apply-patch.txt).

## Setup

Each scenario creates two git workspaces, A and B, under the home directory. TMPDIR and `/tmp` are always writable under workspace-write, so they would hide whether the sandbox follows the move. Each workspace has an `AGENTS.md` that names a different marker. The thread starts in A with `sandbox: workspace-write`. A dynamic tool, `switch_workspace`, stands in for the consumer's change-directory tool. The adapter applies the move inside that tool's handler, before it returns the tool response. Evidence comes from the `cwd` Codex reports for each `commandExecution`, the files that relative-path commands wrote, a write to an absolute path in A after the move, and the model's answer for the marker.

## Results

| Scenario | What happened |
|---|---|
| `inplace-sequential` | `turn/settings/update {environments:[B]}` → `{"status":"applied"}`, then `thread/settings/update {cwd:B, environments:[B], sandboxPolicy: workspaceWrite}`, then the tool response. The next step's commands ran with `cwd=B`. A write to A was **denied by the sandbox** (`operation not permitted`). The model answered `MARKER-B`, so **project instructions follow the move**. The next turn also ran in B. |
| `inplace-parallel` | The switch and a native command were emitted in one batch. The native command **started 61 ms after the switch call, while the dynamic call was still pending, and ran in A** (`batch.txt` landed in A). |
| `gated-parallel` | Same batch, but the thread uses `approvalPolicy: "untrusted"`, and the adapter declines a command approval while the switch is pending or when its `cwd` is not the current context. The stale command was **declined** and nothing ran in A. Even `cat AGENTS.md` asked for approval and was declined. |
| `gated-parallel` + `apply_patch` sibling | `apply_patch` is exclusive, so it waited until the parallel dynamic call finished, then ran **after** the move was acknowledged. Its path was still resolved against the old step: it wrote `A/batch.txt` although A was no longer a workspace root, because a pending-only gate accepted it. A gate that checks the paths from the preceding `item/started` declined it. |
| `steer` | An active-turn `turn/start {cwd, runtimeWorkspaceRoots, sandboxPolicy}` returned the **same** turn id (it steered). The running turn kept A: relative writes landed in A, the write to A **succeeded**, and the model answered `MARKER-A`. Only the next turn moved (`thread/settings/updated` fired immediately). |
| `boundary-parallel` | The switch call was held, then `turn/interrupt`. The pending dynamic call completed as `failed`. A late tool response after the interrupt was ignored. Then `turn/start {toolOutput: switch_workspace, cwd/roots/sandbox: B}` started a new turn, which recorded a `functionCallOutput` item and ran in B. The same-batch sibling **had already run in A** before the interrupt. |
| `concurrent` | Two threads on one app-server moved independently. Each ran in its own B, and each was denied writing to its own A. No cross-thread leakage. |

## Source facts behind the results

- `turn/start` on an active turn calls `start_or_steer_turn`. On steer, core runs `apply_steered`, which persists thread settings for future turns only ("The active turn keeps its existing context", `core/src/session/turn_input.rs`).
- `turn/settings/update` (`core/src/session/step_activation.rs::apply_turn_settings`) installs new environment selections that the **next step** reads. Each step captures a `StepContext` (environments, tool router, `AGENTS.md`). Tool calls from a step execute with that step's context, even if they run after the update.
- Sandbox writable roots come from the environment's runtime workspace roots (`permission_profile_with_workspace_roots`), so a turn-scoped environment change also moves the writable roots. A write to the old root is denied unless it comes from an in-flight call of the old step.
- In 0.169, `DynamicToolHandler::supports_parallel_tool_calls()` returns `true` (0.163 used the trait default, `false`). A dynamic call therefore takes the shared side of the parallel-execution lock: parallel natives (`exec_command`) run beside it, and exclusive ones (`apply_patch`) wait for it and then run in the old step's context. Responses API requests always send `parallel_tool_calls: true`, and no config disables it.
- Both settings methods require the `experimentalApi` capability: without it, `turn/settings/update requires experimentalApi capability`. A turn update for a turn that is no longer running returns `{"status":"targetUnavailable"}`, not an error.
- The only client-side hooks on native execution are approval requests (`item/commandExecution/requestApproval` carries `cwd`; `item/fileChange/requestApproval` carries `itemId`, and the paths arrive in the preceding `item/started`).

## Requirement

The consumer problem (plan 488) is that a session told to move keeps working in the old directory: Codex keeps executing there, so commands such as `npm i` land in the wrong place, and the model starts improvising workarounds (`ln`, absolute paths). Access to the old directory is not itself the problem. The requirement is that the **new directory becomes the effective base directory**: the default working directory for native commands, the directory the model is shown, the project instructions and the writable workspace.

## Selected mechanism

**In-place move, acknowledged before the tool response.** Inside the switch tool's handler, before its response is sent:

1. `turn/settings/update {threadId, turnId, environments: [{environmentId: "local", cwd, runtimeWorkspaceRoots}]}`, which must return `{"status": "applied"}`. It applies from the running turn's next step.
2. `thread/settings/update {threadId, cwd, environments, sandboxPolicy | permissions}`, which applies to future turns.
3. Send the tool response. The handoff is reported as **effective from the next step**.

Both updates are acknowledged before the tool response goes out, so the acknowledgement never waits on the response. The turn, tool-result pairing and usage stream are unchanged, and no user message is manufactured. The consumer's approval policy is untouched.

Which writable roots to pass is the consumer's policy. With roots `[B]`, a write to the old directory fails loudly (`operation not permitted`), which surfaces drift instead of hiding it. With roots `[B, A]`, the old directory stays writable.

`inplace-sequential` and `concurrent` show the result. Without any `cd`, the next step's commands ran in B, the model followed B's `AGENTS.md`, and the next turn stayed in B. `steer` shows the failure mode this replaces.

### Optional: report old-directory actions

The adapter can watch `item/started` and report any command or file change that started in the old directory after the switch was requested. Doing so is cheap and makes the same-batch case visible. It detects but does not prevent.

### Not selected: approval gate

A strict variant runs threads with `approvalPolicy: "untrusted"` and has the adapter decline every command or file change outside the current context (`gated-parallel`). It stopped every stale action in the probe, but it puts every native action through the adapter, partly reimplementing Codex's approval logic, and it must be on for every turn because the approval policy cannot change mid-turn. It is not needed for the requirement above. Keep it in mind only if a consumer later needs a hard "nothing runs in the old directory" guarantee.

### Fallback: turn boundary

Interrupt, then `turn/start {toolOutput, cwd, runtimeWorkspaceRoots, sandboxPolicy}` (`boundary-parallel`). It works without the experimental API and on Codex < 0.169, and it pairs the tool output without a manufactured user message. The cost is a new turn id.

## Known limits

- **Actions emitted together with the switch may run in the old directory.** Codex gives no ordering barrier: dynamic tools are parallel in 0.169, and calls from the step that contained the switch keep that step's context and sandbox, even when they run after the move is acknowledged (`inplace-parallel`; `apply_patch` in the pending-only-gate log). This affects at most that one batch; the next step runs in the new directory.
- **A model can still type an absolute path to the old directory** from memory (Codex issue #12232). Whether that write succeeds depends on the writable roots the consumer passes.
- **The move is two requests.** The turn and thread updates are not atomic. If either fails, or the turn update returns `targetUnavailable`, the handoff must report failure, never success.
- **Running terminals and background processes stay** in the old directory, as the contract requires.
- **Experimental API.** Requires Codex ≥ 0.169 and the `experimentalApi` capability. Re-run the probe after each Codex upgrade.
- **Not exercised:** permission profiles instead of `sandboxPolicy`, worker-pool reuse and resume across processes. Each scenario ran 1–3 times.

## Upstream change that would close the same-batch gap

A per-tool barrier, for example a `DynamicToolSpec` flag that makes a dynamic tool exclusive *and* re-captures the step context for queued siblings, or a `turn/settings/update` option that cancels the current step's queued calls. Neither exists in 0.169. Not required for the selected mechanism.
