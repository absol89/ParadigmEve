# Native ChatGPT subagents: supported boundary and Eve design

Status: **c18 opt-in research ledger source implementation; no selectable native executor, native dispatch API, installation or live hosted-child proof**. Started 26 October 2026, branch `release/2.4.5` at/after `e00462de`. The ledger alone does not make a browser tab, consume model inference, or prove account entitlement.

## Product decision

1. **Default:** Eve's established, visible ChatGPT worker conversations. Their separate chat content and approvals are available for human review, and Eve retains its existing conversation-bound broker receipts. Keep existing runs, account-selected Chat model and reasoning, Free/Go native default, and browser recovery authority unchanged.
2. **Experimental candidate:** Prime-mediated *native hosted delegation request* inside an eligible, **human-selected ChatGPT Work** conversation. Children have their own hosted contexts and return findings to Prime; Eve has **no verified per-child principal, tool receipts, permission boundary, cancellation signal, or guarantee of start**. Never describe this as a directly controlled worker backend or let it inherit the ordinary worker's effectful authority.
3. **Explicit alternatives:** local Ollama and separately configured OpenRouter workers continue through their existing, different execution/consent paths. Never fail over from a refused or unavailable native request, never silently enable or bill an OpenAI inference API, and never change the user's Chat/Work, model, or reasoning picker.

## Current platform evidence and blocker

The official [ChatGPT Work subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) documents asking ChatGPT *within the parent Work chat* to delegate. Hosted children inherit parent tools and connector-specific permissions. It documents no third-party native child spawn/status/cancel API or separate per-child permission controls. The [ChatGPT-plan preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) explicitly exclude top-level Responses `multi_agent`; the [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) can coordinate **local** child agents with plan authorization, which is a different runtime and not proof of hosted collaboration integration.

In Eve, `src/main/agents.ts` dispatches only registered executors after a durable broker admission; `src/shared/agent-backends.ts` marks `gpt-work` executor unsupported. Native children have shown the **same exact Companion conversation/session as Prime**, not independently proved identities. `src/main/mcp/work-context.ts` does not claim child lineage; `src/main/mcp/kernel.ts` and `src/main/session/recorder.ts` do not create verified child receipts for Prime-looking calls. No host-supplied child ID may be invented from worker labels or model text.

Therefore it is **not currently safe to implement a third `workerRuntime` value as a working native executor**. A renderer-only selector would be deceptive, and an ordinary Eve `agents action=spawn` must not create worker topology for this unsupported runtime. Native children cannot be given Eve worker-only capabilities on their claimed identities.

## Design for a truthful Prime-mediated research experiment

This is an opt-in **delegation request protocol**, *not* a supported native worker execution driver. It needs its own admission and durable report owner before shipping:

1. Verify a live exact Prime conversation and explicit current user opt-in. Present the warning that the Work conversation and its parent tools are selected by the human; individual child permissions/receipts, use, start/cancel status, and billing are **not independently verified by Eve**. Request at most four bounded, read-only research assignments, with no secrets or effectful local task.
2. Durably create a broker-owned `delegationRequestId`, exact Prime family/session, assignments, constraints, user acknowledgement, and status `prepared`. No worker identity or `running` status is created at preparation. Make the generated instructions visible and reviewable to the human/Prime; an eligible Work parent may choose to invoke its own hosted subagent feature. A refused/unavailable feature yields `unsupported` or `unknown`, with no retry or fallback.
3. Prime reports the returned assignments/results with a bounded size and source references. The ledger labels each `reported_by_prime` and **never** `verified_child_tool_receipt`. A missing/ambiguous report stays `unknown`. Preserve four distinct reports even when the ChatGPT sidebar is empty. Never invent native child IDs, tool calls, timestamps, account billing, or token consumption.
4. Cancellation only means `cancellation_requested` until actual host confirmation is available; it cannot be presented as child termination. A restart recovers the request and known reports, not the hosted child process; never replay uncertain prompts or tool effects.
5. Because native children are indistinguishable from Prime at Eve's connector, the research ledger blocks *effectful Eve tools for the entire parent conversation* while its request is active or unknown, including a stale/missing local session join. A record can be settled by the exact proved parent session even if its Prime run ID changes after restart; the original ID remains audit provenance. This is a dispatch admission fence, not revocation of an already-running effect, and cannot constrain ChatGPT or other connectors. Written read-only instructions are not a child sandbox.

The c18 setting enables only the documented research ledger, **not** a native worker route or hosted dispatch control. Do not expose a selectable executor or claim hosted execution until human-selected in-ChatGPT Work acceptance and truthful status/result UX are proven. `ChatGPT chats · Auditable` remains the default; explicit other-provider choices remain separate.

## Gate for a true Eve-controlled backend

A genuinely controllable native hosted runtime needs a supported host API returning unforgeable delegation/child lineage, lifecycle events, completion and tool traces; Eve must bind that proof to its own `(runId, workerId, delegationRequestId, capability policy)` before any child effect. No such interface is documented or observed. If one becomes available, add one backend owner and negative tests; do not route through DOM scraping, undocumented ChatGPT internals, or a self-reported child name.

An **alternative product** is plan-authenticated Codex app-server with local child agents, separately named and consented. It is not native ChatGPT hosted subagents and must not replace the user's Chat-mode/default worker setting or turn the pre-existing GPT Work OAuth/Responses draft into a silently billed fallback. That implementation would need its own explicit user decision, model-entitlement proof and tool security review.

## Required negative and live acceptance

- Default visible chats unchanged; research-record opt-in defaults off, no selectable native worker executor and no automatic Chat/Work/model/reasoning switch.
- Shared Prime conversation proof never becomes independent native child authority; spoofed child labels fail; no child-level receipt is inferred.
- Research-only parent-wide Eve tool lock denies an effectful request including after restart; unrelated host tools are explicitly outside this claim.
- Four assignments are not marked as four running workers merely because a prompt was sent. Prime reports remain separate, durable, bounded, and visibly unverified.
- No API key/model fallback, provider switch, ambiguous replay, duplicate prompt, browser tab opening/reload/focus theft, archive/Plan/schedule mutation, or changes to existing runs.
- Live in-account Work experiment demonstrates actual delegated reports and missing/visible approvals; compare CPU/RAM/latency with four browser-backed GPT workers before making any default change.
- Full `verify:ci`, package provenance/byte smoke, installed-byte verification and live Companion acceptance are separate gates. Existing c17 debug remains installed until all are satisfied. The pre-existing uncommitted GPT Work `jose`/OAuth draft must not be dropped, silently committed into a candidate, or bypassed with a dirty-lockfile packaging option.
