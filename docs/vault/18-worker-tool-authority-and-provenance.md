# Worker tool autonomy, permission longevity and caller provenance

**Status:** 2026-10-22 implementation specification and acceptance plan for
`release/2.4.4`. Design approval means permission to implement and test, not
proof of installed behavior, c5 acceptance or upstream ChatGPT permission.

## User requirement

The user wants one durable **Eve-owned** decision to authorize Prime and workers to use
the approved tool set, without returning each worker operation to busy Prime. Record
which originating chat/run/worker performed each operation. Restore ongoing authorized
work after app restarts, and avoid losing a task when ChatGPT unexpectedly asks for
approval. Do not require a desktop-bound approval interaction when the user is away.

The installed Eve app's local `allowOtherChats` policy was effectively enabled
(`work_context` returned `shared-eve` on 2026-10-22), and ChatGPT's
**Eve-specific permission already read `Allow all actions`** on that date.
The repeated ChatGPT prompt was for the Eve `agents` connector tool. Therefore
changing the same setting again is not a verified fix. ChatGPT owns the upstream
tool-approval gate and may still block, challenge or omit a call. Eve cannot
replace, override, auto-confirm or promise immunity from that platform gate.

## One owner for each authorization fact

1. **ChatGPT platform approval:** owned by ChatGPT. Its latest response is an
   external admission/refusal, never proof of local task completion. Display
   `provider_approval_required` separately from Eve permission denial and
   transport outage. No automated approval-clicking or hidden retry.
2. **Local capability grant:** owned by Eve main process, durable in app data.
   An explicit human grant names the grant version, enabled capabilities,
   approved roots, principal scope (Prime, its worker family, bounded routine),
   issue time and revocation epoch. A worker may inherit only a subset. A
   local project/Thread/ChatGPT page may not widen roots or rights. Revocation
   takes effect on every new operation, including after a restart.
3. **Invocation principal:** a native Eve worker gets its exact run incarnation,
   worker id and task id from the local broker. A ChatGPT call gets the
   normalized inbound request id, and its conversation/session only when the
   Companion proves the *same request id* in exactly one document. The source
   is not inferred from tab focus, title, recency, the only active worker,
   account-wide access or a model-authored argument.
4. **Execution receipt:** the Eve main process durably records accepted,
   started, completed/failed or suspended states, linked to one principal,
   grant and idempotency key. Return results directly to the owning worker's
   durable inbox; Prime observes outcomes but is not a tool dispatcher.

## Provenance contract

Store per accepted operation:

- `operationId`, `grantId`, `grantVersion`, `revocationEpoch`, tool,
  target descriptor/digest, timestamps, outcome, remote/local transport,
  and response receipt.
- `runIncarnation`, `workerId`, `taskId` and local session when from
  Eve's native worker broker.
- `inboundRequestId`, `conversationId`, `sessionId`,
  `browserDocumentId` and navigation epoch only when individually proven
  by the matching request/document evidence. Preserve A/B lineage on
  Compact & Resume.
- `provenanceLevel`: `exact_browser`, `native_broker`, or
  `connector_unattributed`. A shared-Eve call lacking page proof must
  *not* be attributed to Prime's chat. Never put a guessed chat id in the
  audit record. Retired/dormant worker ambiguity must not turn a
  shared-authority fallback into impersonation of Prime.

Keep sensitive arguments, secrets and unrestricted user content out of
summary logs; the app's existing exact tool records can retain protected
details under their normal policy. Audit metadata must survive restart and
be searchable by operation, chat, session, worker and request id.

## Independent execution and recovery

- A worker's tool request goes directly to an Eve-owned broker/executor using
  its issued principal. It does not queue behind Prime's model turn, and
  different workers may run concurrently within bounded tool/resource limits.
- The broker authorizes each operation against the **current** local grant,
  root/capability policy, worker lifecycle and exact operation owner.
  Authorization is checked again at dispatch after any wait.
- Journal the request before side effects; deliver a result to the exact
  worker inbox after completion. Distinguish queued, dispatched, tool
  finished, result delivered and model acknowledged. A 60-second model
  response window is not the lifespan of an accepted local operation.
- On a provider approval denial or unavailable connector, suspend the exact
  external operation as `awaiting_provider_approval` with its provenance
  and intended next step. Do not auto-replay a send, browser mutation,
  installer or command with unknown outcome. Notify the user of the blocked
  action when a supported notification channel exists; a phone alert must
  not be mistaken for remote authority to approve ChatGPT.
- Never reload, close, navigate, retarget or steal focus from an active
  ChatGPT tab; preserve voice/drafts, the user's model-picker choice and
  installer-driven reboot semantics. Restart resumes only work with an
  unambiguous durable checkpoint; expired/unknown ownership fails closed.

## Implementation sequence and acceptance gates

1. **Evidence and diagnosis (2.4.4):** correlate the repeated ChatGPT
   `agents` prompt with a normalized request id, tool name, worker-start
   event and eventual acceptance/denial. Log the distinction among
   ChatGPT approval refusal, local authorization refusal, missing Companion
   attribution and transport failure. Do not store approvals as if Eve
   granted them. Establish a minimal fresh-worker repro.
2. **Provenance hardening:** define one typed principal/receipt shared by
   MCP ingress, agents, worker broker and recorder. Stop shared authority
   from impersonating an unproven chat; add explicit
   `connector_unattributed` presentation and tests for unknown or retired
   worker identity. Preserve legitimate authenticated phone access without
   fabricating its source conversation.
3. **Durable app-owned grants:** implement an explicit local UI for Eve-wide
   and inherited worker capabilities using one main-process grant store.
   Preserve existing approved roots and restrictive overrides; support
   revocation, versioned migration and restart without duplicating the
   authority in renderer, browser extension or chat prompts.
4. **Native worker execution:** give each worker a bounded local principal,
   direct tool dispatch, independent concurrency and durable inbox/receipts.
   Prime coordinates, not serializes each action. Implement bounded load,
   worker sleep/revive and app-restart recovery using the same owner.
5. **Release acceptance:** unit tests for grant inheritance, expiry/revoke,
   unknown/foreign/retired caller, exact request join, duplicates and late
   results; integration tests for several workers executing tool operations
   while Prime is busy, surviving a restart and completing without a
   60-second lost-send window. Observe whether ChatGPT still presents its
   own dialog separately. Prove installed c5+ payload, then dogfood the
   candidate without manually killing Eve before its installer relaunch.

This plan does **not** assert that ChatGPT will honor a saved permission
indefinitely, that a ChatGPT-hosted worker can use a blocked connector call,
or that an Eve-local grant authorizes operations outside its approved roots.
The durable autonomy guarantee can apply to an accepted local broker task;
new ChatGPT-hosted tool invocations remain subject to ChatGPT availability
and policy.

## Implementation contract: reuse existing owners

The implementation must be an integration into the current architecture,
**not a second agent manager or an independently writable grant mirror**:

| Existing owner | Required change / invariant |
| --- | --- |
| `src/main/mcp/inbound.ts` and `src/main/session/correlation.ts` | Normalize one HTTP request id and join it with one page-observed conversation. No model-supplied chat id or fallback to active tab. |
| `src/main/mcp/kernel.ts` | One admission decision per actual tool call; snapshot its caller principal, check effective capabilities and refusal reason, preserve the original request id through the recorder. |
| `src/main/eve-access.ts` and `src/main/config.ts` | One app-local authorization owner. Preserve the existing `eveAuthority.allowOtherChats` setting; version rather than replace it when worker inheritance/grant scope becomes necessary. |
| `src/main/agents.ts` | Durable prime-run incarnation, worker identity, state and inbox. Neither a worker label nor Prime's current chat is a worker credential. |
| `src/main/local-agent-runtime.ts` and existing broker adapters | Use the already-issued process-local principal for native worker invocation. Never leak its unguessable handle to the model. Reissue only from validated restored run/worker records. |
| `src/main/session/recorder.ts` and `src/shared/session.ts` | Extend existing ToolCallRecord and unattributed activity as needed; do not make a second audit database. Keep request/chat/worker provenance and local grant decision readable. |
| `src/main/mcp/tools-core.ts` | `agents` remains lifecycle/messaging. It must not be a generic proxy for other workers' tools, and a shared-authority call cannot act as an unproven worker. |
| `src/main/bridge.ts` and Companion | Page observations and document epochs supply evidence, never arbitrary remote permissions. No reload to repair lost attribution. |
| Renderer settings/activity | Show effective Eve-local rights, attribution level, and provider-vs-local blocking separately; do not imply that Eve changed ChatGPT's account setting. |

### Caller and grant model

Each execution resolves to **one** of these mutually exclusive cases:

1. **Exact ChatGPT caller:** normalized request id has a matching, locally
   admitted Companion observation naming exactly one conversation/document
   and its local session; if the chat belongs to a worker, its run incarnation
   and worker id come from the broker's durable binding.
2. **App-owned native worker:** a live `LocalAgentExecutionPrincipal` issued
   internally for that exact run/worker/backend. No ChatGPT conversation is
   invented; the durable worker's recorded origin is a *lineage reference*,
   not proof that the current local operation came from that web chat.
3. **Authenticated shared external call:** inbound connector request is
   verified and the user's current `allowOtherChats` grant permits it, but
   exact source chat evidence is unavailable. Record its normalized request
   id with `connector_unattributed`. It may use self-contained operations
   within existing local capabilities/roots; it cannot acquire another
   worker's inbox, process, chat identity, or run-control authority.
4. **Rejected:** no usable principal, revoked capability/root, conflicting
   identity, retired/blocked/superseded worker, invalid grant version, or an
   operation that requires a specific chat but lacks proof. Return a stable
   refusal code before any side effect; never retry as Prime.

Do not treat **sharing authority** as **sharing identity**. Worker origin
may be a durable relationship to the Prime run, but the action itself must
be attributed to the worker's principal. A Prime action is a Prime action.
A worker result delivered to Prime is not a Prime-executed tool call.

The grant is a human-approved, locally durable Eve setting with these
logical fields (field spellings may be mapped onto existing config schemas
without adding a second store):

- Grant id/version, enabled/revoked epoch, issuing local user action/time.
- Scope: installation/Prime family/specific worker/bounded routine.
- Allowed existing capability names and approved-root ids. A worker inherits
  intersection with its parent; never a union or new root.
- Optional expiry and per-operation sensitivity policy. Effective authority
  is rechecked at dispatch, not frozen forever at enqueue.
- Invocation idempotency/receipt id, local session and exact run/worker
  principal where applicable. The active ChatGPT model/reasoning setting
  remains a separate human picker decision, not part of this grant.

Config migration is **additive**. Existing installations keep their saved
`allowOtherChats`, approved roots, per-tool capabilities, self-app controls
and recording choice. An absent new grant field must not silently expand
an existing user's rights. Explicit disabling/revocation always wins.

### State and delivery contract

Use the existing durable session/outbox/broker message owners where they
already cover a transition. A logical tool request has at most one durable
execution identity and proceeds:

`offered → admitted → running → completed → result_offered → acknowledged`

It may instead become `refused` before dispatch, `failed` after an
unambiguous execution failure, or `suspended` when future execution needs
external permission or a live user decision. Each transition is
time-stamped with the same task/worker and idempotency identity. Treat
`result_offered` as *not yet acknowledged by the receiving model*.

- Commit admission/side-effect intent before dispatch; finish and result
  state are committed before reporting success.
- An app restart reconstructs only durable claims/receipts. For an unknown
  external effect, do not execute again; preserve it for explicit
  reconciliation. A completed result may be reoffered to its **same**
  worker without rerunning the effect.
- A worker sleep, Compact & Resume or Prime's busy turn must not discard its
  unfinished accepted operation. A failed worker that never bound a chat
  may be reported as startup failure, not impersonated or counted as a
  completed task.
- The 60-second conversation-response deadline is not an app-local executor
  cancellation clock. Concurrency is bounded per capability, with
  independent per-worker in-flight ownership and queue receipts.
- The provider may reject a *new* ChatGPT tool invocation before it reaches
  Eve. Since Eve never received that call, it cannot fabricate a receipt for
  it. If Companion independently observes a specific approval prompt,
  record only that observation; never click to approve it automatically.

### User-facing diagnostics and control

Show an action as **Executed by Worker N**, **Executed by Prime**, or
**Shared Eve access — source chat unverified**, using the actual proven
principal. A detail view displays request/operation id, known chat
conversation, run incarnation, local session, grant version, capability,
target root, start/outcome time and delivery status. Missing evidence
displays `Unknown`, never a convenient chat title.

Offer a single local grant control with clear inherited worker scope and
revocation, using current root/capability selectors. Distinguish these
errors explicitly:

- `CHATGPT_APPROVAL_REQUIRED`: only when independently observed upstream;
  no tool action was admitted locally.
- `EVE_GRANT_DENIED`: the local permission/root/principal refused work.
- `CALLER_IDENTITY_REQUIRED`: the requested operation needs an exact
  owner and it was not proven.
- `TOOL_TRANSPORT_UNAVAILABLE`: the request could not reach the
  executing service; outcome may require reconciliation.
- `RESULT_DELIVERY_UNCONFIRMED`: local effect completed but its owner
  has not acknowledged the result.

The app can notify the user about a blocked state through a supported
independent channel, including mobile if implemented, but the notification
is never a surrogate ChatGPT approval or a trigger for automated clicks.

### Acceptance matrix — necessary before a candidate claim

| Case | Required observed result |
| --- | --- |
| Two GPT workers call different tools while Prime is generating | Each operation is recorded under its own exact worker conversation/run, executes independently, and neither waits for Prime to relay it. |
| Worker A tries to use worker B's session/process/inbox | Refused before side effect; no attribution or result routed to B. |
| One request id appears under two browser conversations, or the page navigates A→B→A | No false proof; owner-sensitive actions fail closed and existing user pages are not reloaded. |
| Authenticated phone/shared-Eve call has no Companion | Self-contained authorized operation can run and is marked `connector_unattributed`; worker-specific actions are refused without exact proof. |
| Sleeping/retired/blocked worker has a tool call in flight | An already-admitted exact effect finishes to its own receipt; new unauthorized calls are refused and no Prime identity is borrowed. |
| Grant/root revoked while queued or running | New dispatches stop; completed effects remain visible; in-flight noncancelable effects are reconciled honestly. |
| Provider asks approval despite Eve Allow all | Show upstream block only when observed, preserve original task context; never auto-click, retry unknown effects or broaden local grants. |
| Worker completes local effect but delivery takes over 60s | Durable receipt survives, is reoffered once to the correct worker, and Prime can see status without dispatching it. |
| Installer/restart during accepted workload | App retains durable receipts and runnable work; no manual process kill, data-folder uninstaller, duplicate send or phantom completion. |
| Three-worker load and restart acceptance | Zero cross-worker misroutes/duplicate effects; all admitted operations end in confirmed outcome or explicit suspended/unknown state. |

### Delivery phases

- **A. Contract and evidence:** land this spec; capture one prompt's exact
  layer and one worker startup identity-loss trace. Add tests proving
  shared authorization never becomes a worker identity.
- **B. Harden existing ownership:** keep current recorder/broker as the
  only authority; add missing origin/grant evidence and stable diagnostic
  codes without changing user grants or introducing an approval bypass.
- **C. Worker direct execution and durable receipts:** adapt the native
  worker principal and existing executor path, reconcile incomplete work
  across shutdown/restart, preserve independent concurrency and inbox
  ownership. Do not call an API path ready if it cannot actually run.
- **D. Settings and acceptance:** expose the single local grant and
  provenance UI; verify negative cases, typecheck, focused tests, full CI,
  packaged source hashes and installed c5+ dogfood. Never broaden a
  capability merely because a test cannot establish a caller.

Every phase lands with focused regression tests and a checkpointed diff.
No public merge/tag/push is part of this authorization. A packaged candidate
is a separate evidence-backed acceptance step, not the definition of
source completion.
