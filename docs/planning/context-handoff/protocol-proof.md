# Execution-context handoff: protocol proof

Evidence record for plan 004 `protocol-proof`: how a running Codex turn can move to another working directory, and what the adapter must add so that no native action runs under the old context.

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

## Selected mechanism

**In-place move plus an adapter approval gate.** This is the smallest mechanism that enforces the contract:

1. Inside the switch tool's handler, before its response is sent: `turn/settings/update {threadId, turnId, environments}`, then `thread/settings/update {cwd, environments, sandboxPolicy | permissions}`. Both are acknowledged before the tool response goes out, so the acknowledgement never waits on the response (contract 5). The turn, tool-result pairing and usage stream are unchanged; no user message is manufactured.
2. While a handoff is pending, and for every later action in the turn, the adapter answers approvals itself. It declines a command whose `cwd` is not the current context, and a file change whose paths are not under the current writable roots. Anything else goes to the consumer's own approval policy. This needs the thread to run with `approvalPolicy: "untrusted"` so that native actions reach the adapter. Without that, nothing can stop a same-batch sibling (`inplace-parallel`).
3. Failure handling: `targetUnavailable`, a rejection, or a failed thread update after an applied turn update (the two requests are **not atomic**) leaves the session refused/interrupted. It is never reported as moved.

The turn boundary (`boundary-parallel`) also works and preserves pairing via `toolOutput`. It has the same same-batch hole and also changes the turn id and continuation, so it is only a fallback for Codex < 0.169.

## Guarantees that are not available

- **No ordering guarantee from Codex.** A native call in the same batch as the switch can start before, during or after the switch. Only the approval gate decides whether it runs.
- **Actions without an approval request cannot be gated.** That covers MCP tool calls, `view_image` and other in-process reads, and anything else outside the command and file-change approval paths. Reads of the old workspace stay possible, because the sandbox allows reads everywhere.
- **Same-step siblings keep the old sandbox.** If the gate accepts one by mistake, the sandbox will not stop it (`apply_patch` wrote to A after the move).
- **`approvalPolicy: "untrusted"` is required for the barrier.** If a consumer runs `never`, it gets the in-place move without a barrier, and the adapter must refuse to report the move as safe.
- **Commands emitted before the switch** in model order may be approved before the adapter sees the switch call. They are treated as pre-handoff actions.
- **Experimental API:** the field is behind `experimentalApi`, so its shape and semantics may change between Codex releases. Re-run the probe after each upgrade.

## Upstream change that would remove the gate

A per-tool or per-call barrier, for example a `DynamicToolSpec` flag that makes a dynamic tool exclusive *and* re-captures the step context for queued siblings. Another option is for `turn/settings/update` to cancel or reject queued calls of the current step. Either would let the adapter drop the `untrusted` requirement. No such field exists in 0.169.
