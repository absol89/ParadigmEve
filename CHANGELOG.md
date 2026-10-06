# Changelog

All notable changes to this project are documented here.

This project is in **beta** despite its version number. Behavior may still change between
releases.

The app and the `extension/` Companion are versioned together. Managed Windows self-reinstall
materializes the packaged Companion and restarts/recovers the dedicated browser profile
automatically; **do not manually reload it during that flow**. For manual or otherwise non-managed
updates, reload the matching unpacked Companion only when Chrome is still running an older Companion
runtime. If the app and Companion bridge protocols are incompatible, ParadigmEve refuses the stale
peer until the matching Companion is active. Connector-schema refresh in ChatGPT is a separate
operation.

## [2.3.6] — Talk, plan, delegate

2.3.5 was an internal dogfood build and is not released publicly; its changes below ship with 2.3.6.

### Added

- *(in progress)* Interpreter → Plan → orchestrator → workers. See `docs/eve-tasks/interpreter-orchestrator-2.3.6.md`.
- Ollama chats can use Eve's Core tools directly (Setup → Ollama → *Use tools directly in Ollama chats*, on by
  default). With it off, the Ollama model keeps the conversation and hands tool work to a worker. Images in the
  chat reach vision models as image parts.
- After an Ollama-started chat moves to ChatGPT, the first ChatGPT answer is recorded even when its tab
  is in the background, and the next message reaches the page instead of failing after 60 seconds.
- Open Archive Browser opens the existing archive pages at once and refreshes them in the background; it
  used to rebuild the whole archive first, which took minutes on a large archive. The Archive screen's copy
  is plainer, and the archive shows what you wrote rather than Eve's catch-up wrapper after a provider switch.
- Separate worker limits for GPT, local Ollama and Ollama Cloud workers. An Ollama worker keeps the model it
  was started with, even if the Setup model changes while it runs.
- Moving an Ollama-started (or local-only) chat to ChatGPT works again. The ChatGPT catch-up no longer re-uploads
  earlier images into the fresh ChatGPT chat (the message failed whenever ChatGPT did not confirm those uploads); it
  says how many images each earlier turn had and that they are in Eve's archive. Eve's own chat and the swarm Prime
  are never reused for a fresh input or closed as idle tabs: the fresh chat had taken over Prime's tab. A failed
  attachment upload now names why (no file input, tile mismatch, timeout and counts), failed browser deliveries are
  logged with their input id, and every tab the Companion closes or reuses is logged with its reason and proof.
- Switching a chat's provider no longer freezes the app. The consent dialog sat inside the (hidden) Pets panel, so
  opening it made the window modal while the dialog itself was never shown; it now lives outside every panel, with a
  layout test and a runtime guard. The consent preview also opens the chat once instead of reading its history twice,
  and counts without loading long-message text; chats recorded before per-message storage get their history again.
  Each switch logs `provider-switch timing` lines (preview, consent, send, enqueue) to the app log.
- Ollama model discovery lists every model you can use. The local Ollama app's `/v1/models` showed only models
  already pulled, so cloud models were invisible. The picker now reads the app's own model list (which marks cloud
  models exactly and says which read images), adds the public Ollama Cloud catalog under the app's cloud names, and
  pulls a cloud model's small stub on its first use. Models are grouped "On this computer" and "Ollama Cloud", with a
  search box, and a visible **Local only** checkbox filters to local models: for a new chat it locks the chat to this
  computer from its first message, and for an existing chat it is that chat's lock.
- Plan model for that pipeline: Plans carry a revision; steps can nest (4 levels, 100 per level, 400 per Plan)
  and carry their own intent, constraints and exact source messages (Voice, typed or tool). An executor claims a
  step at an exact revision; the claim keeps the wording it started from and is marked superseded when a later
  revision rewords the step. One step in progress per claimant. A chat has one active Plan; a new one starts only
  after it is completed or cancelled. Worker Plans can link to their parent step and revision. Plans written
  before 2.3.6 load unchanged.
- Text, pasted info and attachments sent from Eve's chat during a ChatGPT Voice call are queued and typed in the
  next pause: after the current turn has ended and nothing new was heard or said for 3 seconds. They never cut into
  a running turn and do not expire while you keep talking. Send reads "Send in next pause" during a call.
- Chats write Plan revisions themselves: `update_plan` takes stable step keys, parents (4 levels, 60 steps), intent and
  constraints, and the app links each new or changed step to the user's messages since the last revision, marked as
  spoken (Voice) or typed. In Voice, the model updates the Plan when something settles rather than per utterance, and
  after a call ends Eve asks once for a revision if anything new was said.
- Send to orchestrator: the chat's Plan card shows nested steps with their intent and constraints, and a Send button
  for each new revision. The orchestrator may claim steps only from a sent revision; Setup → Advanced can send every
  revision automatically. Saying "send it" in Voice sends the revision the model writes.

## [2.3.5] — Choose who answers

### Added

- Ollama as a chat provider in the desktop chat window. The composer's model menu switches between ChatGPT and
  Ollama per turn; Ollama models come from the provider's live `/v1/models` list and are passed through unchanged.
  An Ollama turn is an ordinary outbox row tagged `provider: 'ollama'`: the browser and tool transports never claim
  it, a local driver records the user message through the same receipt path and streams the reply into the same
  session archive (`provider` on both messages). Stop works on a running Ollama turn; a restart closes it as
  interrupted and replays rows accepted before the restart.
- Mid-chat provider switching with one archive. Ollama turns receive the whole conversation, including ChatGPT
  turns and their images (vision models only; a non-vision model refuses a new image with a clear error). A
  ChatGPT turn after Ollama turns carries a bounded catch-up of exactly the turns it did not see, frozen into that
  delivery, plus up to four of their images. A chat started on Ollama binds a real ChatGPT conversation to the same
  session on its first ChatGPT receipt, behind the recorder gate Compact & Resume uses.
- Switch consent: when a turn would hand earlier history to a different provider, the composer shows the exact
  scope (messages, images, files) and main refuses the send without that confirmation
  (`PROVIDER_SWITCH_CONSENT_REQUIRED`).
- Per-chat **Local only** lock: only a loopback Ollama endpoint serving a non-cloud model may answer. Models whose
  id ends in `cloud` and HTTPS endpoints are labelled and treated as Ollama Cloud.
- Optional Ollama API key in secure storage, sent only to HTTPS endpoints (direct `https://ollama.com/v1`); a
  blank endpoint means the local Ollama app.
- Text and image attachments are copied into the session archive on delivery (`archivedAttachments`), so later
  turns on any provider can read them after staged uploads are pruned.
- Ollama as a worker-only driver: Prime stays in ChatGPT; each Ollama worker is a one-shot, terminal local
  execution with a broker-issued principal and the live Core permissions; restarts fail in-flight Ollama workers
  visibly and revival is refused. Readiness reports `ollama-worker-config-invalid` until a model is set.

### Fixed

- ChatGPT Voice replies were missing from Eve. The Companion read only `content_type: text` messages, and Voice turns
  are `multimodal_text` with `audio_transcription` parts; most spoken replies were never reported. Voice
  transcriptions are now read for both sides (only the transcription text crosses into the extension, never audio
  pointers), and a finished spoken reply ends its turn unless ChatGPT marks the turn as continuing, so Voice turns
  no longer pile up as "interrupted".
- Compaction and repairs no longer fight a live Voice call. The page reports Voice state; while a call is live the
  app files no automatic compaction ticket, pauses a pending ticket's pickups without counting them toward
  `handoff_never_sent`, queues no repair reloads, and the page does not start compacting. The Companion also leaves
  an audible tab alone. The handoff no longer lands in the voice chat when the call ends.
- Ported from upstream chat-on-steroids 2.1.24–2.1.27:
  - the chat Compact & Resume moved you into is never closed as an idle app-owned tab (0eb1e3c6);
  - the replacement chat's ownership gate is re-armed when its Send is dispatched after a long wait, so the
    resumed chat is not filed as a separate session (5ecb19ff);
  - recovered handoffs carry provenance and restart refuses a brief that belongs to another continuation
    (fb19351c);
  - a Goal "goal is met" decision settles its turn at once, even if the chat's page never acknowledges it (ffd69e0c);
  - finals that existed before a Send are history, so a fast first answer can still close its own turn (1f093832).
- A LAN peer privacy test asserted a three-letter substring that random ciphertext contains about once in 500 runs.

## [2.3.4] — Speaking your language

### Added

- Latin American Spanish (`es-419`) alongside English and Swedish: a full app catalog, a language picker in Setup and
  Settings, and Spanish pet descriptions. Every language shares the same English-keyed catalogs.
- The localhost setup guide opens in Eve's language, has a three-language picker, shows Eve's coffee cup as its header
  icon and favicon, and translates the connector description users paste into ChatGPT.
- The installation's agent name (and its possessive: `'s` in English, `s` in Swedish, `de` in Spanish) now replaces the
  default "Eve" throughout the interface; "Eve Browser" and "Eve Plugins" stay product names.
- Localized aliases for the shipped starters (`%utgifter`, `%gastos`, `%hur`, `%cómo`, `%organisera`, `%organizar`,
  `plan`/`planer`/`planen`/`planes`) route to `%expenses`, `%how`, `%organize` and `#plans` for context injection, the
  Expenses project binding and in-chat links. A routed alias tells Eve which language it is and to answer in it when
  the rest of the message agrees.
- The Schedule screen's "Chat about" shortcuts are `#schedule` (also `#schedules`), `#myweek` and `#routines`, with
  Swedish and Spanish spellings routed to the same names. A localized spelling reaches Eve as the Schedule shortcut
  even when no Quilt exists, instead of being ignored.
- Conversational reminders and routines now persist a bounded continuation capsule with their purpose, desired
  outcome, relevant decisions/observations, constraints, requested format and exact source references. Core's unified
  `schedule` tool can list/create/update/pause/resume those Eve routines from an exact current chat and uses the same
  action surface for evidence-backed completion of a running scheduled chat.
- Pets can be renamed from their menu (display name only; the package folder and `pet.json` are untouched) and
  `pet.json` accepts optional per-language `descriptions`.

### Changed

- `%Hotlink` is now `%Instruction` (`%Instruktion`, `%Instrucción`). Stored data and behavior are unchanged.
- The Pins screen shows the shipped starters under their localized names in Swedish and Spanish.
- **Open static archive** is now **Open Archive Browser** (**Opening Archive Browser…** while it works), in every
  language, and on Windows it brings the browser window it opened to the front.

### Fixed

- The static chat archive's search box hides non-matching chats again (the chat-link `display` rule overrode `hidden`).
- Connector card text that embeds the per-install name, and the Avatar count labels, are translated instead of
  falling back to English.
- Plans from a chat that went through Compact & Resume can be checked, cancelled and archived again; the Plan follows
  the session's current conversation while the source still holds the same checklist, and still refuses to overwrite
  a genuinely different one.
- Saving state no longer fails when Windows briefly locks the target file (`EPERM`/`EACCES` on rename), which had
  surfaced as "Plan source changed" or a failed save. The write retries for about a second before giving up.
- Schedules created before 2.3.4 run again: 2.3.4 added `context` to the hashed schedule payload, so every earlier
  schedule failed "Scheduled work authority does not match its executable payload". The old digest is accepted for
  work that has no context.
- Project rows in the chat list no longer reserve room for their hidden + / delete / link buttons, so long project
  names truncate only as much as chat titles do (#8).
- A compaction pickup no longer waits behind a chat whose answer ChatGPT broke off ("Connection interrupted. Waiting
  for the complete answer"): the page declines it and the pickup reloads the chat, immediately when Stop is gone and
  after a minute when Stop stays up (upstream 1928e304, 4a91a685).

### Added

- `move_eve_here`: on the user's explicit request, any ordinary working chat can become the Eve/Eva (Prime) chat
  even when the old one was deleted or is locked behind a usage limit. The durable owner and the whole worker family
  move together, are saved before success is reported, and roll back on failure. The old chat takes no part. It is
  refused for workers, blocked or superseded chats, chats that already lead another family, and an old Prime that is
  working right now.

## [2.3.3] — Compaction and recovery fixes

### Fixed

- A working chat whose current turn already made an exactly attributed tool call is no longer reconnected or
  reloaded for an unattributed call that arrives later in that turn (upstream 614583e).
- A new turn stays open when ChatGPT remounts the previous answer below the new question or hands the page a stale
  descriptor of the previous final (upstream 4d25a82, #746).
- A restart recovery is still sent when ChatGPT replaces its composer after the text was typed but before Send was
  authorized; the draft follows the new editor once (upstream 73f76ab, #744).
- An interrupted-response repair keeps a chat open once ChatGPT has recovered on its own instead of reloading it,
  and that does not spend the turn's one error reload (upstream 8b01399, a231d58, c8721d1).
- A source chat's reload note no longer appears above the first message of the chat Compact & Resume opened, and the
  replacement's typed message is recorded even when its first tool call committed the move first (upstream ebb67b5).
- When a sent handoff's three writing-phase reloads are spent, the chat records one visible note instead of going
  quiet (upstream 78c5452, second half).
- A Compact & Resume replacement tab that Chrome did create is no longer reported as a failed placement when
  recording its protection fails (upstream a72e8f0).
- A context frame read back with spaces serialized as `&#x20;` is recognised again instead of being shown as the
  user's message (upstream issue #821).
- A Compact & Resume replacement tab is never reused for another message. Typing an unrelated message into it moved
  the tab to another chat and left the handover blocked for good.
- A Compact & Resume that was in flight when the app restarted is finished afterwards. The source chat is no longer
  left refusing every tool with `COMPACTION_IN_PROGRESS`, and a restart wake waits for the move instead of being typed
  into the chat being replaced.
- The replacement chat sends the brief when ChatGPT swaps its message box during page hydration (React #418), before
  the send check, during it, or while Send is still disabled. Before, the brief vanished and nothing was sent.
- An unanswered send check on the replacement chat is asked again instead of silently stranding the brief beside an
  enabled Send button. Every remaining stop before Send names its reason in the tab's console.
- An automatic compaction waits up to six minutes for a long local call to finish after Stop, instead of thirty
  seconds, so a turn running long commands compacts instead of growing forever (upstream 18ab425, #825).
- A session's archive keeps growing after a late-recorded event puts it out of order. Before, everything recorded
  after that point was silently left out.
- Model discovery never uses a tab a command just opened. It could open ChatGPT's model picker in a Compact &
  Resume or worker tab while the bootstrap was being typed there, replacing its message box (upstream cfb62e3).
- Stop closes a turn that stayed open after ChatGPT went idle, instead of failing because there was no Stop control
  to press and leaving the chat holding the next message (upstream ed081b1, #864).
- A worker's first message that ChatGPT did not accept is cleared from the message box instead of looking like
  something you still have to send; text you typed there stays (upstream 6661b27).
- A pinned tab stays where you pinned it when background chats are on (upstream 5f051ad).
- The `%claude` starter is now a general way for Eve to reach Claude, through Claude Code (`claude -p`), a shared
  file, or the Claude app or claude.ai, instead of instructions written for one installation's release work. An
  unchanged copy upgrades on its own; a prompt you edited is kept.
- Agent guidance and the Expenses playbook now require conversation-dependent reminders to retain
  the user's intent, useful non-ledger observations, completed actions and output preferences. The
  scheduled run must recover that context and check current ledger data instead of improvising from
  a bare reminder in a fresh chat.

### Also covered

- Upstream's tests for the remounted rich composer (c469aa5) pass unchanged against ParadigmEve's own composer lookup.

### Not ported yet

- Opening the replacement in the browser that holds its source and one-browser-only new chats (upstream beb596b,
  10ecf80) rely on multi-browser plumbing ParadigmEve does not have.
- Capturing a brief from the recorder when ChatGPT remounts a long answer (first half of 78c5452) and the long
  silence window for Extra high, Max and Ultra turns (537aafb, which needs 280f3d0) depend on upstream
  infrastructure that is not in ParadigmEve yet.

## [2.3.2] — Desktop pets and Eve avatars

### Added

- Desktop pets, ported from Chat On Steroids 2.1.20: a transparent, always-on-top, click-through overlay window
  (interactive only over the pets' own hit regions) where enabled pets idle, wander, can be dragged and poked, and
  react to the projected task state (spawn when work starts, look while waiting, angry on failure or block,
  celebrate when ready for review). One pet carries a task badge and tray whose rows open the chat.
- A Pets settings page and a View → Desktop Pets toggle. Pets are validated "cos-pet" packages of exactly
  pet.json, atlas.png (1280×1920, 96 frames of 160 px) and animations.json; the importer checks sizes, dimensions,
  the fixed frame layout and hand anchors, rejects symbolic links and re-serializes both JSON files, so a package
  never carries code. Bundled pets ship read-only in resources/pets and cannot be deleted, only turned off.
- Hammy (from Chat On Steroids) is bundled; a cat and a dog are assigned to Eve under the new Vault page
  15-desktop-pets-and-avatars.md, which is also the contract Eve follows when a user asks for a human avatar of her.
  The Pets page hands users a short prompt for that.

### Changed

- The upstream brand-joke scenes are neutral in ParadigmEve: "Swing at a bug" (Bug → Fixed) and "Toss a TODO".
- The chat list's working-state rule moved to src/shared/session-activity.ts so the pets and the chat list share
  one owner.

### Not ported

- Upstream's Windows-only focus return after dragging a pet (needs the native `koffi` module) and the built-in
  Tur Tur Sahur and Capy pets.

## [2.3.1] — ChatGPT page fixes from Chat On Steroids 2.1.17

### Fixed

- Compact & Resume now completes a replacement-chat handoff when ChatGPT accepts the native Send
  but delays exposing the new user message to the Companion. The same authorized browser document
  can use Chrome's concrete successor route as a narrowly fenced fallback, including the transition
  where source chat A remains in the current URL while replacement chat B is already in `pendingUrl`.
  The fallback refuses A, stops after trusted user interaction, and never invents a destination
  message id; unresolved sends remain unresolved rather than being replayed or guessed.
- App-sent images and files attach again with ChatGPT's current composer: the upload input is elected by kind inside
  the composer form instead of the removed `#upload-photos`/`#upload-files` ids, and the new image tile counts as the
  upload receipt. Delivery errors wrap instead of being cut off.
- A new turn is no longer closed by the previous answer that ChatGPT remounts above its question right after Send.
  ParadigmEve checks each section's document position against the exact question, so a reused page turn id still
  lets a genuinely new section below it belong to the new turn.
- Native Send click/submit/Enter capture is registered through the recorder's cleanup, so a retired recorder stops
  capturing sends.
- ChatGPT `:::writing{…}` blocks render as a titled quote instead of the raw directive.
- Chats started from the app are titled from the user's request, not ChatGPT's title for Eve's instructions, and
  stored instruction titles are repaired on load; "ChatGPT - <project>" page titles are ignored.
- Setup, the health card and docs point to Plugins → Add → Create MCP App; Developer mode is described as an
  older-ChatGPT fallback, and setup asks users to keep the suggested app name.
- The prime is told worker reports arrive only with tool results, to collect pending ones with one status call
  before finalizing, and to say review is pending rather than claim delegated verification is complete.
- Goal and Loop: the helper sees how many Eve tool calls each turn made (never names, arguments or results unless
  the user opted into tool detail), so it stops asking for work that already ran, and `session_finish` no longer
  stays held after a continuation worked through with tools only. Hold calls are not counted as work.
- Goal and Loop keep working when the saved helper model or reasoning is no longer offered: the helper uses
  ChatGPT's current selection, logs it once and names the model it actually runs. A saved worker default the
  account does not offer is dropped the same way, with a note in the spawn result; explicit requests stay strict,
  and GPT-5.6 Sol keeps its shipped handle.
- Goal/Loop helper chats no longer report request origins, so they stop opening empty "ChatGPT session" rows, and a
  finished helper tab still closes after ChatGPT moves it to `/c/<id>?temporary-chat=true`.
- Core instructions explain ChatGPT's transient "couldn't determine the safety status" refusal (retry the identical
  call once), and `session_finish` is offered to any model when the user prompt asks for it.
- A restart wake the reloaded ChatGPT page never admits no longer strands Eve's chat. After five minutes with the
  wake still queued for the same open turn, no local call running and no generation reported, the app starts one
  Compact & Resume for that chat. That ticket never clicks Stop: if ChatGPT is still answering, the page refuses and
  withdraws it.

## [2.3.0] — Windows-named installers, a Companion that updates itself when idle

### Changed

- Windows installers are published as `ParadigmEve-Windows-<arch>-debug.exe` instead of `ParadigmEve-Setup-…`.
  2.2.9 installations update into them automatically; 2.2.8 and older only know the `Setup` name and need a manual
  install (or 2.2.9 first). The updater still accepts the legacy `Setup` name second.
- The Companion reloads itself into the build the app ships (ported from chat-on-steroids 2.1.17) only when idle: the
  app reports `companionBusy` in `/status`, no bridge command may be in flight, and every ChatGPT page must answer
  its ping with `busy: false`. It no longer reloads the moment `/hello` names another build. `/hello` keeps the
  field for Companions up to 2.2.9, which still reload that way.

### Fixed

- Expenses `record` rejected every reasonable receipt shape because the published tool schema left `facts` opaque
  and the validator required keys that are honestly unknown. The `facts` contract is now published in the tool
  schema. Unknown optional facts (`location`, `notes`, item details, `items`) default to null or empty, JSON numbers
  are accepted as decimal amounts at the tool boundary, and rejections name each bad field. `expectedRevision`, the
  accounting backstop (`purchasedOn`, `merchant`, `currency`, `total`) and full-object `correct` stay mandatory.

## [2.2.9] — Clearer Windows downloads

### Changed

- 2.2.9 keeps publishing the existing `ParadigmEve-Setup-…` Windows installer names so 2.2.8 and older installs
  can update into it normally.
- The 2.2.9 updater also understands `ParadigmEve-Windows-…` and prefers that checksum-authorized name when
  available, preparing 2.3.0 to switch the public Windows filename without breaking updates.
- Public macOS release assets now use DMGs only; ZIPs remain CI/test artifacts rather than duplicate user downloads,
  and the public `SHA256SUMS.txt` lists only attached assets.
- Eve's coding instructions gain a short always-on "Changing code safely" section (find every copy of a rule, prove
  fixes with a failing test, separate refactors, treat test time as a range, never change user data as a side
  effect), with fuller checklists in the packaged Vault page `14-coding-skills.md` read only when needed.
- Eve delegates sooner: a task likely to take more than about a minute, or with two or more independent
  workstreams, starts by checking workers and parallelising suitable bounded work, while Prime keeps synthesis,
  decisions and user communication.

## [2.2.8] — Steadier recovery, Pins prompts from Eve

### Fixed

- Messages no longer overlap or hide behind the composer: the Companion's activity stream mounts inside the
  exchange ChatGPT measures.
- Restart recovery opens Eve's exact chat through the running Eve Browser profile when Windows refuses window
  focus, so the queued wake posts.
- The browser journal keeps only the newest unsent snapshot of a streaming message, so an outage cannot evict
  real messages.
- The Plans catalog holds 5,000 Plans instead of 500, and never removes archived Plans automatically.
- The heartbeat's closed-identity warning describes a closed tab rather than an ended chat.
- Ported from chat-on-steroids 2.1.16 ("fewer stuck chats"): a large Project source chat gets 60 s to load before
  Compact & Resume's native click (#457); a worker or resume bootstrap reacquires a composer ChatGPT replaces after
  model selection instead of failing with `composer_missing` (#470); Goal recognises the current Temporary Chat
  icon and introduction (#472); a stream request reported twice in one batch is kept instead of rejected (#464);
  an automatic Compact & Resume ticket that has not reached Send is retried in two slower bursts before it is
  abandoned (#391).

### Added

- `pins` MCP actions for Thread prompts (`create_thread` with `prompt`, `set_thread_prompt`) and Pin Hearts
  (`set_pin_sticky`).
- A shipped `%claude` starter Hotlink for Eve ↔ Claude coordination.
- **Cancel plan:** a Live Plan that is no longer relevant can be cancelled (two clicks). It moves to Done as
  Cancelled with its checklist exactly as it was, instead of ticking items only to archive it.

## [2.2.7] — First GitHub-published debug pre-release

### Changed

- Built and published by the GitHub workflow as a debug pre-release; once promoted to Latest, 2.2.6 Windows x64
  debug installations update to it by themselves.
- The bundled OpenAI `tunnel-client` is now v0.0.15, pinned by the SHA-256 of all six platform archives.

### Fixed

- Compact & Resume commits again when ChatGPT's fresh-chat composer sends the typed brief as escaped Markdown
  (`\` hard breaks, `\-`, `` \` ``, `&#x20;`). The replacement chat now recognises its own `[[CLF-RESUME:…]]`
  bootstrap, so the session, its history and the Eve identity move to the new chat instead of the new chat
  being recorded as an unrelated session.
- When the chat review heartbeat waits because the saved Eve/Eva identity names a chat that has ended, the log
  says so and names that chat, as a warning.
- The publish workflow no longer fails when GNOME's GitLab refuses the GitHub runner: the 24 KB `gvdb` source
  archive ships as a reviewed in-repo copy with the same pinned size and SHA-256, and other native source
  downloads retry.

## [2.2.6] — Compact & Resume on ChatGPT's current layout

### Added

- The app offers the GitHub release marked **Latest** in `absol89/ParadigmEve` as an update, checked at most
  every six hours next to the local private feed. Drafts and pre-releases are never offered, a build only takes
  artifacts of its own flavor, and the download must match the release's `SHA256SUMS.txt`. Windows and Linux
  AppImage installs stage and install it; other installs get a **View release** button.
- Release CI builds the debug flavor (`-debug` artifacts), and `publish.yml` creates every release as a
  pre-release. Promoting a vetted release to Latest is what makes installations update to it.

### Fixed

- Compact & Resume completes again on ChatGPT's render-item layout. The Companion now reads user messages from
  their `user-message` render items, so the `[[CLF-HANDOFF:…]]` / `[[CLF-RESUME:…]]` markers are found, and a
  finished reply counts as a stable brief. Previously every automatic compaction sent its handoff, ChatGPT wrote
  the brief, and the ticket stayed `dispatched-unresolved` until cancelled.
- The platform notes (macOS floor, Linux sandbox fallback, unsigned builds) now live in `docs/setup.md`, so the
  README can stay a product front page.

## [2.2.5] — ChatGPT stream attribution

### Fixed

- Restores exact tool-call attribution on ChatGPT's current conversation stream, where chat identity and request
  id now arrive on separate events. Fresh Eve calls no longer wait 20 seconds and fall into Unattributed activity.
- Keeps an early request-id sighting until the matching MCP call arrives instead of consuming the sighting on the
  first premature lookup.
- Re-offers recently sighted request ids after an app restart, allowing a turn that spans a ParadigmEve update to
  recover attribution once the restarted app sees the matching call.
- Stops attribution repair from reloading a ChatGPT tab while its reply is still streaming.
- Preserves exact-chat safety: browser sightings do not create local traffic by themselves, cannot overwrite an
  existing correlation, and exact-owner mutations still fail closed without proven identity.

### Verified

- Installed Windows dogfood proved a fresh Eve turn as `callerIdentity: proven` for its exact Eve conversation,
  with the first attribution wait reduced to `identity_ms=2` and the next call at `identity_ms=0`.
- `app.log` recorded the request as attributed **from its earlier stream sighting**, with no `no page evidence ...
  Unattributed activity` fallback for those fresh-turn calls.

### Credits

- Thanks to the **Chat-on-Steroids contributors** whose upstream investigation and fixes around issues **#414,
  #432, and #433** inspired the 2.2.5 stream-compatibility work. ParadigmEve adapts those ideas to its own
  exact-chat identity and restart-recovery model.

## [2.2.4] — Durable local chat archive browser

- Restores Eve assistant replies in app chats on ChatGPT's per-exchange renderer: the reply's message model
  is read through its own search unit instead of being lost behind a tool-heavy activity tree.
- Links an Eve project to one native ChatGPT Project by its exact link: chats in that Project join the
  Eve project, and fresh Eve chats open inside it (or fail visibly) instead of at the ChatGPT root.
- Stops stale "Still working" toasts from finished requests (for example old %plans onboarding chats):
  the check-in now needs the request's chat to have a live open turn, not only its admission state.
- Records Eve replies on ChatGPT's render-item page (2026-09-26): the page no longer exposes message objects,
  so the Companion reads each reply's `assistant-message` item and its streaming context instead.
- Runs the installed Companion build: the app refreshes the Companion folder before launching its browser,
  and a Companion still running an older same-version build reloads itself once, so page fixes take effect.
- Delivers the restart wake to Eve's exact open turn before automatic compaction may post its handoff,
  instead of retiring the wake as "the conversation moved on".
- A silent install that closes a running ParadigmEve starts the installed app again when it finishes.
- Keeps Free/Go Eve chat on ChatGPT's native default only: the model menu exposes **ChatGPT Default**
  and hides the thinking-effort slider instead of offering a non-working Free-account Think mode.
- Expands Expenses into a low-friction batch receipt workflow: multiple receipts per phone photo,
  duplicate itemized/card-slip collapsing, readable item/price capture, branch/address-aware merchant
  history, tolerant faded-receipt intake, and exact original retention only for plausible durable
  return/warranty proof.
- Makes `%expenses`, the built-in `#expenses` convenience alias, and Pins → Start chat share the same
  linked Expenses project and operating prompt, while preserving a real user `#expenses` Quilt as
  ordinary data-only Quilt context. Existing app-owned Expenses `AGENTS.md` files migrate only from
  known shipped hashes; the canonical ledger is not rewritten by that startup migration.
- Adds opt-out account-wide Eve authority for authenticated ordinary ChatGPT connector calls so a
  phone/other-computer chat can reach the installation Eve's approved workspace when exact owner
  browser identity is unavailable, while worker and Goal-helper families remain excluded.
- Adds a local durable chat/archive browser with append-only semantic evidence, content-addressed retained blobs, a rebuildable search/index projection, and a static `file://` recovery view with sidebar chat navigation and full transcript scrolling.
- Makes native/generated ChatGPT image evidence first-class: exact provider identity is retained, already-loaded local pixels are captured when available, reboot/offline recovery uses local bytes, and uncaptured provider-only states stay explicit instead of pretending to be durable.
- Adds the Archive workspace and narrow path-free renderer IPC, while hardening archive/store/blob publication against symlink/junction escapes and retiring archived evidence when the user explicitly deletes a session.
- Adds a static archive chat-order toggle (`Newer first` / `Older first`, with Swedish `Nyare först` / `Äldre först`) without changing stable chat hashes, plus the measured 188px desktop sidebar default, a safe GitHub brand action, and a View-menu shortcut to the local static archive.
- Keeps provider-neutral memory separate from transcript evidence, retains portable `.evechat` validation seams, and preserves the existing secure artifact download and session/history tooling.
- The feature line is based on the frozen `2.2.3` source checkpoint and targets tag `2.2.4`; private Windows qualification uses an x64 debug build until installed dogfood and final release gates are complete.

## [2.2.3] — Concepts, friendlier Pins and Plans, and post-Angel dogfood polish

- Adds the current Concepts/Hotlinks/Threads presentation model on top of the durable Pins library, including local Create editing, Quilt grouping, preview controls, safer Links, and current English/Swedish copy.
- Polishes Pins and Plans navigation with clearer workspace actions and the new Pins heart-memo heading icon while preserving exact Pin provenance and Thread/Quilt activation semantics.
- Adds the durable `%plans` starter behind Plans → Create. The onboarding chat starts with `Make me a 3 step plan to get started with %plans`, and the starter description explains that the Plan stays beside the app chat as durable shared state.
- Repairs fresh-chat Plan Request Trail admission when the confirmed app-authored opening is recorded immediately before ChatGPT's first `turn_start`, while continuing to fail closed on ambiguous request ownership.
- Keeps an already accepted durable Plan successful when only secondary Request Trail reconciliation needs repair, so Activity no longer labels that accepted Plan as “Refused.”
- Keeps the 2.2.2 Angel schedule/request/recovery baseline cumulative and bridge protocol **15** while this 2.2.3 line remains private debug dogfood until separately checkpointed and released.

## [2.2.2] — Durable schedules, request trails, and safer Computer Use recovery

- Treats 2.2.2 as a cumulative continuation of the 2.2.1 dogfood baseline, retaining its model-selection, Activity/Pins/Thread, starter-durability, Thread-description, accessibility and browser-recovery improvements. Release provenance now requires those settled changes to live in the same committed target-version tree rather than only in an uncommitted integration workspace.
- Adds first-class `%schedules` / `%evecron` persistence, editing, projection, and installed-runtime execution. User availability stays explicitly known/unknown; Eve duration is explicit authority; shared-free overlap is projected only when both sides are actually known rather than guessed.
- Repairs the shared Schedule editor backplate for both user availability and Eve routines by using the current app theme surfaces, so the dialog and its form controls remain opaque and readable in light and dark themes.
- Runs due Eve schedule work in its own fresh schedule-owned chat lane instead of appending to the user's active conversation. An occurrence may become **Started** only after the browser ACK and exact recorded session prove delivery, and **Done** only after durable completion evidence; restart/retry paths dedupe the same occurrence rather than admitting it twice.
- Adds a durable `%requests` Request Trail with restart-safe check-ins and exact links back to the originating request, owning Thread, Plan, result, tests, and review state. When an exact owning Thread exists, it becomes the Plan's primary Source; historical session/message provenance remains evidence/fallback.
- Separates implementation completion from human signoff. Checking the final Plan item may move work to **Ready for review / Ready to archive**, but the Plan stays Live and no signed-off state is recorded until the user explicitly archives it.
- Hardens Windows Computer Use startup/recovery by enabling accessibility before UIA-dependent observation and allowing a bounded recovery-only focus retry for the exact dedicated Eve Browser window after `FOCUS_FAILED`. Normal Computer Use focus safety remains strict, and recovery never falls back to an unrelated browser window or new tab.
- Makes managed restart readiness attempt-scoped and exact-owner-aware: stale pre-restart Companion document/census evidence cannot satisfy `/recovery`, and an exact durable Eve/Eva recovery owner must appear in a fresh post-restart census before recovery completes.
- Keeps request-id attribution reconnect retryable across the fresh worker/Resume journal gate. A gated or incomplete `/correlations` replay no longer consumes its reconnect token; the same exact page retries after rebind, without weakening caller authority or reloading/navigating a healthy page.
- Keeps bridge protocol **15** because these changes do not require an incompatible app/Companion browser-wire contract.

## [2.2.1] — Active dogfood integration line

- Moves the active dogfood/release candidate to **2.2.1** so continuing integration, packaging, and installer evidence use a fresh release identity after the extended 2.2.0 iteration.
- Keeps bridge protocol **15**; this version rollover does not change the app/Companion browser wire contract.

## [2.2.0] — Free-account readiness, truthful first-tool setup, and Computer Use recovery

- Preserves ChatGPT’s native fresh-chat behavior when a Free/default account has no usable model catalogue: an unselected chat may remain `model=null` / `reasoningEffort=null`, and native Think remains provider-owned rather than being rewritten into a paid-model or local reasoning assumption.
- Carries that provider-native default forward after the first browser receipt creates the durable session. A fresh `null/null` send now records exact per-conversation native browser intent, so follow-up sends stay native-default even if the catalogue is still unavailable; a later explicit model selection remains authoritative and fail-closed.
- Makes model-catalog discovery custody survive Chrome MV3 worker suspension/restart with exact tab/document/navigation/nonce identity. Accepted `/models` observations release recovered custody; rejected or ambiguous observations keep it for safe retry.
- Stops startup model discovery from gaining browser-opening authority merely because the catalogue is unknown. Missing or stale catalogue data no longer bricks a genuinely fresh unselected chat, while explicit existing-session/model selections continue to fail closed.
- Makes Windows Computer Use report zero/all-excluded target discovery truthfully instead of treating an empty list as healthy. Exact native identity remains mandatory; identityless windows are not exposed and there is no process-name fallback.
- Retires stale Window2 coordinate/index authority when a selected window disappears, when the native helper generation changes, and at the durable screen/control permission transition. The same retained caller API must re-list/re-observe before input can succeed after restart or revocation.
- Strengthens first-install readiness so connector discovery alone cannot durably complete setup. Every required non-optional surface needs both real request/discovery evidence and a recognized external tool invocation.
- Keeps first-tool proof scoped to external connector activity: authenticated app self-tests, tunnel probes, and broker-owned local workers cannot mint ChatGPT onboarding evidence. External direct and nested/code-mode calls remain eligible.
- Keeps fresh/default permissions minimal: `roots=[]` and Computer Use off. A safely refused recognized external tool call may prove routing for onboarding, while release dogfood separately requires one harmless Eve tool to actually succeed.
- Aligns current user-facing context vocabulary with ordinary keyboards: `%thread` activates one specific Thread, while `#quilt` addresses a wider Quilt that groups related Threads. Existing legacy storage/type names remain implementation details rather than user syntax.
- Keeps bridge protocol **15** because these changes do not alter the app/Companion browser wire contract.

## [2.1.9] — Thread activation, self-describing `%how`, and durable dogfood checkpoint

- Separates direct `%thread` activation from broad `#quilt` context. `%thread` and explicit Thread-start inject that Thread's standing prompt plus saved Pins, while `#quilt` contributes member Threads' saved Pins without activating their standing prompts.
- Keeps `%how`'s packaged Vault/manual context behind explicit How activation, so `#Eve` can carry broad saved context without silently spending the How prompt/manual budget.
- Ships a self-describing pristine `%how` starter prompt for fresh Eve/Eva installs. It explains the `%thread` / `#quilt` split and names the starter activation directory (`%how`, `%appdata%`, `%expenses`, `%organizer`, with `%how` and `%appdata%` initially under `#Eve`) while treating the installation's current Pins library as authoritative after user edits.
- Keeps the current authored request last in the opening context frame and preserves explicit Thread-start behavior through the existing durable `contextQuiltId` path.
- Packages the current engineering Vault as an explicit installer resource, exposes it read-only at `/paradigmeve-manual`, and synchronizes the installed Markdown byte-for-byte to `%APPDATA%\ParadigmEve\docs\vault` on startup for Eve/Eva access.
- Adds first-class image-message Pin support without storing full image bytes in Pin metadata; bounded local thumbnails retain exact session/event provenance and an explicit unavailable state.
- Hardens browser/local resource ownership so Chrome receives opaque, purpose-bound resources rather than arbitrary native filesystem paths, and adds the self-maintenance/AppData authority needed by current Eve/Eva bootstrap flows.
- Repairs the semantic chat-review heartbeat deadlock so a due review can become a real owning-Eve user turn instead of waiting indefinitely behind an after-turn boundary; semantic completion still requires the exact durable receipt.
- Consolidates the current Pins/Threads/Plans navigation, editable Thread prompt, composer persistence, Setup/recovery defaults, Windows self-window authority, and current English/Swedish UI into the same verified checkpoint.
- Bridge protocol remains **15** because the browser wire contract did not change.

## [2.1.8] — Compact & Resume live-runtime fence

- Fixes the reproduced blank-successor Compact & Resume failure where a marked `?clf=…#clf=…` tab could be created but never reach `/commands/redeem`. The successor watchdog now permits one same-tab recovery reload while the exact marker is still present, unless the page positively reports user/retargeted state that must be preserved; it never opens a second successor.
- Raises the Companion bridge protocol to **15** so an already-resident Chrome service worker from older 2.1.7 bytes cannot continue executing stale pre-fix successor logic merely because the unpacked extension files on disk were refreshed. Same-version stale protocol-14 peers are rejected before browser placement authority is granted.
- Lowers the **debug** dogfood auto-compaction threshold to **300,000** estimated local units with a **400,000** red line, while dev/shipping remain 369,000/492,000. Exact untouched 2.1.7 debug defaults migrate down; explicit custom thresholds are preserved.
- Adds a reusable continuity acceptance gate covering the exact reported marker pair, local `POST /commands/redeem` transport, same-tab reload/redeem, lost redeem replies, slow/final ACK behavior, one-shot destination ownership, restart idempotence, timeout behavior and the lower debug ceiling. ParadigmEve does not depend on ChatGPT's private `/backend-api/f/conversation/resume` request.
- Pins now open the exact recorded source row by durable local `sessionId + eventSeq`, including historical cross-session sources. Chat explicitly loads the bounded history page containing the event, clears filters that could hide it, centers the row and highlights it instead of searching by text or timestamp.
- Historical Pin navigation is protected against a background selected-session/detail refresh replacing the requested page while it is loading. The live regression case now lands on exact durable event 587 in the older source session instead of drifting back toward the live tail.
- Thread detail now exposes direct **Unpin** and explicit **Delete Thread** actions. Unpin removes only the selected Pin and leaves an empty Thread intact; deleting a Thread removes that Thread and its owned Pins in one serialized durable mutation while preserving broader Quilts.

## [2.1.7] — Durable LAN identity and heartbeat budget

- Keeps semantic review on the intended **22-minute** cadence even when a heartbeat completion receipt is rejected or missing. The local maintenance owner may retry transport bookkeeping sooner, but it cannot spend a new model turn for the same confirmed-send debt until the normal heartbeat interval has elapsed; exact Compact & Resume or owner transfer can still move the same debt immediately.
- Adds a durable per-install ParadigmEve LAN cryptographic identity for debug builds. The installation fingerprint is generated once, kept with OS-protected app secrets, and is deliberately independent of IP address, hostname and hardware identifiers so ordinary app updates/reinstalls preserve Eve/Eva's identity.
- LAN nicknames are moving from source-IP/name collision handling to authenticated installation ownership: names are normalized case-insensitively, remembered per joined group against the installation fingerprint, and a different fingerprint cannot silently replace an already-known claim. Partition conflicts fail closed rather than choosing a winner.
- LAN remains a **debug-only presence lab** in this candidate. This identity foundation does not claim that direct `@Eva` agent messaging, VPN transport or centralized global naming already exists.

## [2.1.6] — Compact & Resume browser-receipt recovery

- Hardened the fresh worker/Compact & Resume command boundary against a Chrome MV3 failure where the app durably accepts `/commands/redeem` but the service-worker reply never resolves back to the content script. The exact same browser document now retries that idempotent redeem receipt a bounded number of times before the existing command deadline, so a healthy replacement chat no longer sits blank until ParadigmEve reports that it “did not report back in time.”
- A successfully created successor tab that never reaches the Companion at all now gets one bounded **same-tab reload** while its exact `clf` marker is still present. It never opens a second successor, never reloads a retargeted/user-navigated tab, and reports a terminal placement failure if that one recovery still produces no redeem.
- The retry does not open another tab, does not replay a bootstrap Send, and cannot transfer ownership to a different document: the existing durable command lease and continuation claimant remain the authority. Destination `attempt`/`dispatch` checkpoints are still written exactly once before native Send.
- This follows the separate upstream Compact & Resume failure discussed in Chat On Steroids issue #167; the newer shadow-session guards from upstream PRs #224/#231 are already present in ParadigmEve and remain unchanged.
- Bridge protocol remains **14** because 2.1.6 changes browser-side receipt recovery only; no app/Companion request or response shape changed.

## [2.1.5] — One-agent identity and LAN dogfood candidate

- Replaced the user-facing Prime/Sol/Gaia ownership model with one configured installation agent (`Eve`, `Eva`, etc.) plus her worker garden. Exactly one durable owner conversation may carry that identity; ambiguous history fails closed to a New Chat agent-claim path, which commits only after ChatGPT proves the exact new conversation id.
- Exact owner identity now survives sleeping workers and transfers through Compact & Resume independently of broker-family activity. Restart/reinstall recovery consumes that durable owner only, queues an immediate wake, and keeps Chrome's native session restore additive for the remaining dedicated-profile tabs.
- Added secure opt-in LAN presence with a dedicated OS-protected group key, authenticated/encrypted multicast, no peer action authority, and a privacy-bounded heartbeat projection. The heartbeat also transfers debt away from canonically failed inactive coordinators and can persist a bounded `dispatched` result without exporting Plan/chat content.
- Bridge protocol remains 14. Packaging, install/reboot, live two-PC discovery and actionable-heartbeat acceptance remain separate evidence gates until the 2.1.5 debug installer is built and rehearsed.

## [2.1.4] — Immediate agent recovery candidate

- Supersedes the failed 2.1.3 reboot/reinstall acceptance path. Explicit restart/update recovery now uses restored swarm ownership to reopen only the exact proven owning-agent conversation inside ParadigmEve's dedicated Chrome profile and queues one durable owner wake immediately instead of waiting for the semantic heartbeat.
- Chrome's native previous-session recovery remains additive rather than exclusive: the exact owning-agent bootstrap happens without forwarding the URL to ordinary Chrome, then the bounded `Restore pages?` → `Restore` path is still honored so worker, human and guide tabs can return. Ambiguous owning-agent identity and non-exact recovery URLs fail closed.
- Bridge protocol remains 14. This entry describes the 2.1.4 candidate source; packaging and live reinstall acceptance remain separate gates until the debug installer is built and rehearsed successfully.

## [2.1.3] — Expenses and recovery release candidate

- Added the local Expenses project foundation: a structured local ledger for receipt/text intake, recurring Expenses-inbox ownership, optional local-only receipt retention, monthly budget buckets with per-item overrides, and correction/provenance checks designed to keep receipt evidence out of the ChatGPT Library workflow.
- Added bank-reconciliation primitives that preserve receipts and bank rows as separate evidence, surface probable/confirmed/rejected links, avoid fuzzy auto-confirmation, suppress confirmed duplicates only in derived reconciliation views, and compare reconstructed monthly activity with human-curated reference totals without deleting either source.
- Hardened browser/restart recovery and related session ownership paths around Chrome's native session restore, restored-tab reuse, worker/Prime routing and exact mutation authority; the integrated tree also contains the current Swedish UI, workspace/Pins/Plans navigation, startup/readiness and build-flavor/provider policy work.
- This entry describes the integrated 2.1.3 candidate source and regression scope. Packaging, reinstall rehearsal and installed/live acceptance remain separate release gates and are not claimed here.

## [2.1.2] — Portable gaming-PC dogfood build

- A ParadigmEve installation can give its primary ChatGPT connection a local human name such as **Eve** or **Eva**. That name flows through setup, tunnel/app guidance, connector cards, work context and MCP instructions while the stable product, Companion and MCP server identities remain ParadigmEve-owned. This makes two computers on the same ChatGPT account easier to keep visually and operationally distinct when each has its own tunnel and active chat.
- The app-interface language choice now uses a single current-flag dropdown for **US English and Swedish** in Setup and Settings, leaving room for more locales without adding a permanent row of flags. Swedish localizes app-authored UI while leaving authored conversation text, connector names and technical identifiers untouched.
- First-run and everyday presentation received the current homey guide/startup/Pins/Plans polish, with workspace navigation kept inside the same desktop experience rather than turning onboarding into a developer-oriented checklist.

## [2.1.1] — Pins + Plans visual dogfood slice

- Added first-class Pins and Plans destinations beside Chat. Chat remains the review surface; useful messages, tool results and plans can be harvested into durable Quilt cards without turning the transcript into a library UI.
- Every Pin now requires an explicit Quilt destination. The chooser starts with no Quilt selected and supports either choosing an existing pinned Quilt or explicitly creating a new one; persisted orphan Pins fail closed.
- Added durable global Plans with Live and Done sections, ordered checklist progress, priority/reminder presentation and explicit archive. Completing the final item leaves a Plan in Live as ready to archive instead of silently moving it to Done.
- Accepted session `update_plan` progress now projects into the matching first-class Live Plan only after the existing caller/session stale-call fence accepts the update. Global plan edits retain their own revision fence.
- Hardened Pins/Plans library state against malformed durable JSON and historical message Pins against false Compact & Resume source links. Browser repair now requires a final exact action claim after the Companion's fresh tab scan, so Block/Stop/supersession changes can cancel a stale handout before Chrome mutates a tab; bridge protocol 14 enforces the matching Companion contract.

## [2.1.0] — ParadigmEve private dogfood build

- The 22-minute semantic review heartbeat is now receipt-backed. Its exact review debt is durable before browser transport, survives explicit-user cancellation/restart, and advances only after the authenticated coordinator calls `chat_review_complete`; browser send ACKs, final prose and sidebar state cannot silently retire owed review work.
- Heartbeat completion and recovery now preserve exact session/conversation provenance through Compact & Resume and bounded stalled-owner transfer. Wrong keys, worker/helper callers, ambiguous ownership and nested code-mode completion fail closed.
- Added a Mac-from-USB private build bootstrap plus Setup-time Screen Recording/Accessibility guidance so a copied repository can produce the matching native macOS package without mutating the source checkout or hiding missing OS permissions.
- Refined Quilt's first dogfood model around a checkerboard of durable snapshots: a useful moment is pinned with traceable source context, current state and a small next step rather than becoming another reminder stream. The three 22-minute discovery rides now use that model consistently.
- Added focused regressions for review debt/reissue/receipt authority, exact Core lifecycle exposure and the macOS Setup permission controls.

## [2.0.19] — ParadigmEve private build

- Added a durable 22-minute semantic review heartbeat for the always-on laptop. Eve can recover still-valid user work that fell through as prose by waking one exact proven coordinator, reviewing local session history first, and using the signed-in ChatGPT web history for cross-device conversations the laptop never recorded.
- Heartbeat attention is browser-only, idempotent and subordinate to explicit user input. It coalesces with other internal review work, skips blocked/worker/helper targets, fails closed on ambiguous ownership, and requires Eve to check for newer instructions, already-completed results and currently running work before acting.
- Added the `work_context` Core tool plus matching model guidance so ordinary ChatGPT conversations can verify that the connected always-on computer is available before claiming they cannot save, implement, use Computer Use or dispatch workers. A plan or promise no longer counts as completion when the user asked for execution.
- Added the first three 22-minute Quilt discovery rides and the accompanying product direction: Quilt is a continuity layer for useful moments, source context and small next steps, with proactive support expected to reduce mental load instead of creating another reminder system.
- Eve Browser closure/recovery now prefers the Companion's exact native ChatGPT-tab census over broader presence signals, preserving the 2.0.18 no-duplicate-open invariant when the last ChatGPT tab is closed.
- Added focused regression coverage for heartbeat cadence/durability, exact coordinator selection, browser-only attention routing, worker-attention coalescing, explicit-user supersession and the connected-work guidance surface.

## [2.0.18] — ParadigmEve private build

- Everyday browser recovery now lives in the normal Eve UI instead of Guided Setup. Open/Show/Restore Eve Browser reuses the exact dedicated ParadigmEve Chrome profile, focuses its owned window when it already exists, coalesces repeated recovery requests and restores a missing ChatGPT tab without treating the user's ordinary Chrome profile as Eve.
- First-run completion is now a durable historical fact. Fresh installs must still pass the real end-to-end onboarding checks, while completed users and pre-marker upgrades stay in Chat when the browser, Companion or tunnel is temporarily unavailable instead of being sent back through Setup.
- The Companion reports an exact ChatGPT-tab census separately from its broader 60-second liveness signal, so closing the final ChatGPT tab can be repaired immediately. Failed Chrome tab queries remain unknown rather than being misreported as zero, avoiding duplicate recovery tabs from ambiguous evidence.
- Recorded-session “Open chat” actions now re-resolve the stored conversation in the main process and open it only in Eve's dedicated browser profile. Browser recovery IPC remains restricted to the current live ParadigmEve renderer before any browser side effect can occur.
- Real ChatGPT connector traffic promotes onboarding completion immediately, while self-tests and tunnel probes cannot do so. Healthy Companion traffic also republishes presence at a bounded cadence so the visible app can self-heal a missed reconnect notification after renderer replacement.
- Added focused regression coverage for fresh-install routing, durable onboarding, exact browser ownership, last-tab recovery, renderer authority, exact-session routing, repeated recovery clicks and ambiguous browser-census failures.

## [2.0.17] — ParadigmEve private build

- Worker completion now follows ChatGPT's canonical successful final-assistant metadata instead of sidebar unread dots, quiet time, streaming text or in-progress tool calls. Stable worker finals are durably reconciled across event batches, parsed into the worker report, and can wake Prime for one coalesced review turn without interrupting Prime's live tool sequence.
- Completed workers remain sleeping, writable and reusable. Prime can send bounded follow-up work through `agents action=message` and revive the exact retained worker conversation instead of spawning a replacement or turning the worker into a read-only archive.
- Prime review attention is durable, browser-only, replay-idempotent and subordinate to real user input. It waits behind an active Prime turn, survives a temporarily absent Companion, stays out of the editable human outbox, and fails closed rather than guessing when Prime session ownership is ambiguous.
- App-authored sends now keep the exact elected ChatGPT page render-capable before delivery, while the dedicated ParadigmEve Chrome profile uses a shared aggressive anti-throttling launch policy. Windows launches disable renderer/timer/occluded-window backgrounding plus native occlusion and intensive wake-up throttling; hidden-page semantics are still not claimed to be identical to foreground pages.
- Restart/setup recovery is harder to strand: recovery returns from extension maintenance to the exact owed ChatGPT conversation, completed chats no longer resurrect from stale activity, setup preflight is single-flight and abortable, and recovery remains durable-outbox-first without treating persisted turn ids as live Stop authority.
- Renderer IPC now fails closed unless the sender is the current live ParadigmEve BrowserWindow webContents, including plugin IPC routed through the common wrapper. Worker lifecycle UI/diagnostics also align with broker truth so sleeping workers release active slots without being mislabeled as terminal.
- Added/updated public-focus-test coverage for fresh install, setup/recovery, app-composer browser liveness, renderer authority, worker lifecycle, canonical-final Prime attention and dedicated-browser maintenance.

## [2.0.16] — ParadigmEve private build

- Automatic Compact & Resume now treats wall-clock turn age as a safety limit as well as token pressure. A still-running eligible non-Pro turn receives one durable handoff ticket at 45 minutes from its original turn start, leaving room to stop, settle tools and carry the session forward before the observed roughly-hour response ceiling.
- The deadline is owned by one exact app-side timer rather than a maintenance poll. It follows the durable turn/session/conversation identity, does not move when tools keep working, and is cancelled or re-armed across turn end/start, Pro model changes, Automatic Compact changes, Block/Release, worker binding, compaction/rebind and bridge stop/start.
- Automatic handoffs remain fail-closed under existing fences: Pro/Astra, workers, blocked chats, refused turns, superseded conversations and already-open continuations cannot create a second ticket. A Block racing an already-filed automatic handoff also fences token-specific send actions immediately.
- Added fake-time/integration coverage for the deadline edge, duplicate wakeups, completed turns, Block, workers, Pro→Sol, Auto Off→On, and restart/reattach behavior without changing the permanent 45-minute production value.
- Restart recovery now writes a human-readable `RECOVERY.md` into ParadigmEve userData and durably queues one deterministic recovery instruction for the newest exact unfinished normal chat that proves local tool work. Browser recovery returns to that exact ChatGPT conversation instead of treating `chrome://extensions/` as a waiting destination.
- Recovery is queue-first and never stop-first: ParadigmEve must commit the exact-session recovery message before any later stop could be considered, and this startup path does not issue Stop at all. A failed/ambiguous enqueue leaves the turn running; repeated reboots reuse the same message id rather than duplicating the distress instruction.

## [2.0.15] — ParadigmEve private build

- Dedicated ParadigmEve Chrome now starts on Windows with renderer, timer and native-window-occlusion backgrounding disabled, so turning the monitor off does not freeze the ChatGPT renderer that unattended work depends on.
- Companion update recovery now protects an exact ChatGPT tab from discarding and requests one bounded browser-native reload when neither the old recorder nor deterministic script reinjection can run. A fresh Chrome-issued document registration clears the latch; repeated maintenance passes cannot create a reload loop.
- The screen-off diagnosis was verified against the local power plan: AC system sleep is disabled while the display powers off after three minutes, isolating the failure to browser/display-idle behavior rather than machine suspension.

## [2.0.14] — ParadigmEve private build

- Closed the final assisted-NSIS boundary found by live dogfooding: the InstFiles completion page now auto-closes after ParadigmEve has been launched, instead of leaving an enabled Close button behind.
- The external reinstall controller also recognizes Close only when the installer snapshot explicitly says `Installation Complete`, so older or unexpected assisted-installer behavior still has a safe fallback without ever clicking Close while files are being written.
- The previous 2.0.13 dogfood proved the stronger current-generation Companion + ChatGPT-document recovery handshake live before this installer-boundary follow-up.

## [2.0.13] — ParadigmEve private build

- Self-reinstall recovery now waits for an authenticated ChatGPT document from the exact current Companion generation instead of treating the app's unauthenticated `/hello` identity response as success.
- The Companion reports only Chrome-issued document identities that have registered during the current service-worker lifetime, so persisted tab ownership from a stale worker cannot satisfy recovery after an update.
- Windows recovery materializes the newly bundled Companion, opens Chrome's own Extensions page only in the dedicated ParadigmEve profile, and invokes its native Update control so an unpacked MV3 worker actually advances generations without provider-page automation.
- The external Windows reinstall controller keeps its bounded 30-second retry cadence for two minutes, but exits successfully only after the new app and current Companion page half have both checked in.

## [2.0.12] — ParadigmEve private build

- Closed the restart hole in the Companion-generation fence: an already-authorized Companion now establishes or raises the generation floor on its first authenticated request after app restart, even when no new pairing occurs.
- Protected bridge requests now reject a superseded Companion generation as well as fresh pairing attempts, while retaining the same rollback-safe version bound.
- Added regression coverage for persisted browser authorization across restart and for the raw in-flight shutdown path with the normal Companion version header.

## [2.0.11] — ParadigmEve private build

- Added a monotonic Companion-generation fence so, once a newer compatible ParadigmEve Companion is admitted for pairing, an older compatible worker can no longer take over the local browser bridge again.
- Kept upgrade and rollback recovery intact by allowing the previous matching Companion during an app update and bounding any stored generation floor to the app version currently running.
- Made bridge status report the highest compatible Companion generation seen instead of oscillating between stale and current workers in the activity log.

## [2.0.10] — ParadigmEve private build

- Rebranded the private desktop app, installer, companion extension, connector names and packaged artifacts as ParadigmEve while preserving upstream license and copyright attribution in legal notices.
- Split ParadigmEve into its own OS/package identity so upstream Chat On Steroids installers and automatic updates cannot replace the private app.
- Replaced public release polling with a local-only, digest-verified private update feed and kept the browser bridge protocol identifiers stable for compatibility.
- Added the ParadigmEve gold/blue halo, apple and tree-of-knowledge visual identity across app and extension icons.
- Began the guided first-run browser setup path so sign-in, companion setup, tunnels and ChatGPT connector configuration can be completed from one guided flow.

## [2.0.9] — they nerfed astra

- Code mode combines local and plugin tools in one JavaScript call, with saved task plans and automatic background command results.
- More reliable message delivery, workflow retries, Compact & Resume, worker reuse, and idle browser-tab handling.
- Improved Windows desktop control and window capture, plus faster recording and clearer tool results.
- Simplified Chinese UI, better project and transcript controls, and a reminder to refresh ChatGPT connectors after updates.

## [2.0.8] — 2026-09-08

**Darkex by dark tibo**

- Independent MCP Plugins connector, reviewed catalog and custom server/MCPB installation, OAuth, persistent enablement and update rollback.
- Full third-party notices and exact catalog license provenance, with notice validation in CI and packaging.
- Sidebar resizing/collapse, View menu and Windows title bar; native composer context menus and clearer companion-update actions.
- Safe transcript links, tables, plugin-result image previews, faster session-list loading and bidirectional timeline paging.
- Stable account model/reasoning selection and clearer usage estimates; complete initial plan delivery with ordered checkpoints.
- Durable browser handoffs and queued-input ownership across Compact & Resume; retained waiting/sleeping chats and bounded retirement of completed helpers.

See [the full release notes](docs/release-notes/v2.0.8.md). Binary publication still requires
the native source and artifact-notice checks described in [the audit](docs/plugin-notice-audit.md).

## Earlier unreleased fixes

### Fixed
- **A chat no longer ends on "Message delivery timed out" because one readiness probe was
  missed.** The tunnel watcher asks the client's `/readyz` once every 15 seconds, with a
  three-second timeout and no retry, and a single `false` terminated the client and started a
  replacement. Every request in flight travels through that process: the tool call the model
  was waiting on died with it, no answer could arrive any more, and ChatGPT ended the turn with
  its own transport error and a Retry button. Longer tasks were hit hardest, simply for being
  in flight more of the time.

  A probe can miss without the client being broken — mid-transfer, a briefly loaded machine, a
  slow downstream readiness check. The watcher now requires the failure to survive into a
  second pass before replacing anything, which is the rule the offline caption has followed
  since `UNREACHABLE_CONFIRM_MS` was introduced: one failed poll is not a verdict. It was
  applied there to a caption, and not to the action that kills live work. A client that really
  is unready is still replaced, one interval later.

## [2.0.7] — 2026-09-07

**plus = gpt 5.6; pro = astra**

- Account-specific model and reasoning discovery now handles localized and nested ChatGPT pickers through native metadata. Model availability follows the signed-in account.
- Fewer browser tabs: one operation retains one opening attempt across navigation, closure and restart. Sleeping workers release browser memory while keeping their reusable conversations.
- Durable Goal/Loop and finish delivery preserves the exact task and turn, ordered queues and delivery receipts across recovery. Editing an objective re-evaluates an already completed answer.
- Temporary Goal API failures retry with visible progress and provider retry timing. Finish-generated follow-ups arrive through the next tool response; new input or cancellation retires obsolete work.
- Custom OpenAI-compatible Goal providers have separate credentials. Endpoint, model and reasoning stay together across settings changes; authenticated requests refuse redirects.
- Compact & Resume preserves Project placement, continuation identity and live terminal ownership. Real handoff progress extends manual deadlines; cancelled helpers retire without reopening.
- Explicit Chrome/Edge selection, more reliable startup and exact browser handoffs. Optional Windows login startup respects background launch; macOS startup and reopen handling are hardened.
- Connector refresh checks the installed identity and tool declarations, including native cards with no Refresh button. The companion popup requires confirmed compatibility and explains manual mismatch recovery.
- Drop files or paste images into the composer. Filename cards and previews stay above messages; native uploads retain exact ownership, bounded image handling and send confirmation. Later user drafts survive acknowledged bootstrap cleanup.
- Opt-in artifact downloads save generated files inside approved folders with bounded transfers, validated destinations and no overwriting of existing files.
- Plan stages stay visible during startup. Completed and cancelled planner tabs retire after generation and draft checks; streamed planning and retry progress stays in one timeline row.
- Per-worker model and reasoning selection, reusable sleeping workers and custom Core/Desktop instructions, including concurrent settings-save fixes. Scheduled callers receive clearer guidance when attribution permission is disabled.
- Worker token meters update from recorded tool activity. Usage recognizes the Sol model alias, uses updated configurable rates and preserves proven model identity. Context popups sit directly above the ring.
- Clearer waiting status distinguishes active tools, workers and unknown waits. Tunnel outage detection and missing metrics no longer conflate unrelated states.
- Finish notification actions include the macOS alert-style packaging declaration. Cross-platform regression coverage includes canonical download paths and symlink replacement protection.
- Removed the debugging Reload companion button; normal browser extension management remains available.

**Reload the browser extension after updating the app.** Protocol 13 prevents older companions from silently omitting file attachments.

## [2.0.6] — 2026-09-06

**I am exhausted.**

- New desktop UI, projects, images, model picker and editable plans.
- Durable injections, FIFO after-turn tasks, accurate transcripts, clearer worker messages and retry controls.
- Astra finish queues and Loop; Pro: no auto-compaction, ten-minute recovery window.
- Shared background Chrome, safer tab reuse and worker revival.
- Automatic history scrolling, attachment thumbnails, wrapped tables and context tooltip.
- Fixed New Chat selection, composer spacing and delivery indicators.
- Hardened updater, macOS packaging and cross-platform checks.

## [2.0.5] — 2026-09-04

**The update installs.**

- **An Install update button.** Next to Connect, and in the notice, whenever a verified download
  is waiting. The app quits, the installer runs, and the app comes back as the new version.
  Until now the only way to apply an update was a real quit — and this app is closed to the
  tray, so ending it in the Task Manager instead skipped the handoff entirely and installed
  nothing, however many times it had been downloaded.
- **A download is fetched once.** The staged artifact is kept under the release it belongs to and
  reverified against the release's own published checksums on the next start, instead of being
  forgotten with the process and refetched — a hundred megabytes per start, forever, for an
  installation that never quits.
- **The update notice no longer breaks the window.** The banner between the header and the panels
  had no row of its own to sit in, so showing it squeezed itself to a sliver of clipped text and
  pushed the whole window's contents out from under it.

## [2.0.4] — 2026-09-04

**astra broke me**

- Tool requests.
- Increased stability.

## [2.0.3] — 2026-09-02

**A small step towards the infinite loop.**

- **The Loop.** Goal with the exit removed: every finished turn gets its next message until you switch it off.
- **Improved stability and reliability through auto reloads.** A chat that goes silent, shows an error or loses its tab is reloaded or reopened on its own evidence, and a turn that is still running is never closed early.
- **macOS computer use.** The optional Desktop connector now ships on macOS, off by default.
- **Auto update.** Windows and Linux AppImage installs fetch the next release and apply it on the next quit.
- **Small things.** UI polish, blocked chats, worker recovery, session timeline fixes.

<details>
<summary>Full list of changes</summary>

### Added
- **A blocked chat says so in its composer.** Block is set in the app, and from the ChatGPT page
  nothing said so: the model kept answering with tool refusals. The composer now carries "Chat
  blocked" beside the gear, and hovering it says where the block is undone: the app's Chat tab,
  hover the chat in the sessions list, press its block symbol.
- **The chat page shows why the app reloaded it.** The session log already carried one row per
  browser repair, "Trying to reload chat to recover an interrupted response…" rewritten in place
  to "Reloaded chat to recover …", but the page dropped it because the row names no turn. It is
  now painted between the turns it happened between, with the time, whether or not Overwrite is
  on, so a tab that reloads under you says what happened and why in the chat itself.
- **macOS now publishes the optional Desktop connector.** Architecture-matched Swift code implements
  window/display capture through ScreenCaptureKit, snapshot-scoped semantic controls through
  AXUIElement, and physical mouse/keyboard input through CGEvent while preserving the existing
  `observe` / `computer` schemas, frame identity and partial-batch contract.
- **On macOS the Desktop permissions start off.** The backend is there, but a fresh Mac install
  publishes Core only; switch on "See the screen", "Control mouse and keyboard" or a clipboard
  permission in the Home panel, grant Screen Recording and Accessibility in System Settings, and
  the Desktop connector appears. Windows keeps starting with the Desktop permissions on.
- **macOS packaging and smoke checks cover the in-process Desktop boundary and screen-capture purpose
  string.** Each x64/arm64 package ships a thin Swift dylib plus N-API addon outside asar. A Node
  Worker invokes that backend inside the responsible Electron process, and packaged-runtime smoke
  exercises this real addon/dylib path rather than the standalone development CLI protocol probe.

### Changed
- **macOS builds now require macOS 13 Ventura or newer.** The bundled OpenAI `tunnel-client` v0.0.14,
  which the publish pipeline pins to OpenAI's current release, is built for macOS 13; the 12.0 floor
  of 2.0.2 would have shipped a Connect button that cannot start it. The packaging audit refuses any
  payload whose deployment target is above the declared minimum, which is how this was caught.
- **The model is told not to spam browser instances.** A prime that could not get a foreground
  reading out of the browser window it controlled launched a fresh debug instance on a new port
  and profile for every retry. The exec_command description, which every turn
  re-reads, now says it plainly: keep to one or two browser windows you actually use, reuse the one already
  open, and stop and say so when control becomes ambiguous rather than launching a replacement.
- **Each browser recovery stands on its own evidence, and nothing else.** Silence reloads a chat
  after two minutes with no tool call and no page change, full stop. An error ChatGPT shows
  reloads the chat once per user message, whatever the error says and whether or not the page
  could tell which turn it belongs to. Unattributed activity reloads the chats that are working
  once per server turn: a later unattributed call under the same request id is the same broken
  turn and buys nothing, the next request id is the next turn and gets its own reload. None of
  the three is refused because another one already fired.
- **Goal and Loop chats always come back; everything else is a switch, off by default.** Silence
  and a missing tab reopen or reload a chat the Goal/Loop switch is driving whatever the settings
  say. Workers, primes and plain chats that have called tools are recovered only when "Recover
  other chats' tabs" is on, and it now starts off.

### Fixed
- **A worker chat that opens and never starts is opened once more, not waited on.** The tab the
  app opened for a worker loaded as an empty New chat and never picked up its instruction. The
  app held that page's ninety-second lease to the end, then failed the worker, and only then
  opened the two workers queued behind it, which is why they appeared two minutes after the
  prime asked. A fresh worker page now has twenty seconds to redeem its marker; past that the
  same command is opened again, once, and a second silence fails the slot immediately so the
  line moves. The command is single-owner, so the page that redeems first is the only one that
  types. The old "never handed to a page" retry, a leftover from before every ending advanced
  the queue, is gone.
- **A reload no longer ends a turn that is still running.** The page reloaded in the middle of a
  prime's turn — once for a foreign unattributed call, once for a lost stream — adopted the open
  turn from the app, saw the interim prose ChatGPT had committed and no Stop control, and four
  seconds later reported the turn completed. The same request id then called tools for another
  twenty-four minutes, and Goal wrote the next user message against an answer that had never been
  given. Two changes, one from each side. The page's visible-prose rule now applies only to a
  turn the document has seen running; an adopted turn waits for ChatGPT's own end-of-turn, an
  error, a stop, a new send or the ten-minute stall. And the app treats the server turn as the
  authority: a call under the ended turn's request id that starts after the reported end reopens
  the turn durably, hands it back to the page, and withdraws the Goal decision drafted for it.
- **A stopped turn ends the `active` badge.** The badge went dark only on the model's final answer,
  so a chat whose turn the user stopped — the blocked prime of 2026-09-02, stopped right after a
  refused call — read `active` for three more minutes. Any turn end now ends it, the user's stop
  included; a refused call in a blocked chat still lights it, so a chat that keeps trying can be
  found in the list, and it goes dark the moment its turn is stopped.
- **A page retrying a rate-limited Goal draft is no longer reloaded for it.** OpenRouter answered
  ten drafts in a row with 429 while the page retried every fifteen seconds, alive the whole
  time; the owed-reply watchdog only saw a decision still owed after two minutes and reloaded
  the chat twice for a page that was never dead. Each draft request now counts as the pickup it
  is and pushes the reload out. Provider refusals are also written to app.log, which until now
  held nothing about them.
- **A reload of an open turn is painted inside that turn.** The row names the turn it is
  repairing, so Overwrite lists it among the turn's tool calls, in order, with the ↻ and the
  time. Only a reload with no turn open — a Goal reply nothing collected, a missing tab — still
  sits between turns.
- **A New chat opened in a worker's tab is no longer mistaken for that worker.** The page kept
  the worker label and command id across the move, so every event of the user's own chat went
  out as the worker's, the app bound the slot to it and stamped a worker origin on its session,
  and the user's first message was folded as "the instruction this app gave the worker". A tab
  that leaves the worker's chat now drops the identity with it.
- **A resumed chat no longer inherits the reloads of the chat it replaced.** The session keeps
  its identity across Compact & Resume, so the replacement chat's feed was cut from a log that
  also held the old chat's "Reloaded chat to recover …" rows, and the page stacked them above
  the handoff as if the new chat had been reloaded before it existed. The bootstrap this app
  types is the boundary: reloads before it stay with the old chat, reloads after it are painted
  where they happened.
- **Blocking a chat also stops its Goal, Loop and auto-compaction.** Block refused the chat's
  tools but left the loop typing the next message into it and the threshold free to compact and
  resume it, so a blocked prime or solo chat could carry on, or reopen as a replacement chat the
  block did not cover, with every one of those turns answered by tool refusals. A blocked chat
  now reports Goal, Loop and compaction off with the reason in the composer sheet, refuses to
  take a new goal or turn any of them on, and gets them all back exactly as stored when it is
  released. Worker chats were already fenced.
- **A Compact & Resume whose marker the new chat never redeemed no longer strands the session.**
  The replacement chat was opened, the brief sent, and the prime in it went to work on the
  predecessor session — but the app committed the continuation only from the marked message the
  page had to find, and once it did not, the session stayed on the old chat, the new one was
  refused as a stranger running someone else's swarm, and the loop was dead. The new chat now
  also reports the id ChatGPT gave it, and the app commits from that report exactly as it does
  from the marker.
- **A Goal or Loop chat that stops with no final answer gets its next message anyway.** Two
  minutes of silence earn the reload as before; if the fresh page shows the same dead turn for
  one more minute — no tool call, no page change — the loop treats it as a finished answer and
  files the next message. A stop you pressed yourself never triggers this.
- **A call the app cannot place no longer tells the model to ask you to clear a worker.** The
  message now says the app reloads the affected chat shortly because of the unattributed
  activity, and to try once more.
- **A closed Loop chat is reopened after Chrome restarts.** The app asked for the reload two
  minutes after the chat went silent, but the extension only polled for recovery work while it
  still held tabs or queues. After a browser restart it held neither, so the request was never
  collected and the Loop prime stayed closed. The extension now asks the app on every pass and on
  browser startup as long as it is paired.
- **A worker that reported its finished task shows "sleeping" straight away.** The report parks
  the run when it was the last working worker, and a parked run has no agent view for the session
  list to read, so the row fell back to the activity heuristic and said "active" for three minutes,
  then nothing. The finish is now recorded on the session itself and the row reads it.
- **Blocking a worker's chat frees its swarm slot at once, restart or not.** A worker whose chat
  the user had blocked was slept only when its in-memory silence grant expired. After a restart
  there was no grant, so the restored run carried the blocked worker as active with no tab for an
  hour, the next prime was refused with "another conversation is already running the swarm", and
  the slot came free only when the tab finally closed and the detached clock ran out. The sweep
  now sleeps every slot-holding worker whose chat is blocked from the durable block alone, and
  pressing Block runs that sweep immediately.
- **A goal started from an empty New Chat keeps retrying through a provider rate limit, with the
  same "Retrying Goal in 15 seconds" card an in-chat turn shows.** The opening request asked
  three times with a one- and two-second pause between them, which is shorter than any real rate
  limit, and then painted "The goal loop stopped" over a run that had not started. It now waits
  on the same quarter-minute clock as the in-chat loop with no attempt limit, and stops only when
  the app refuses for a settled reason, the composer is no longer that empty New Chat, or a
  different goal is saved over it.
- **A chat in a background tab reports its answer the moment it lands, not when you click the
  tab.** Chrome slows a hidden tab's timers to one wake-up a minute once the tab has been hidden
  for five minutes, and the extension's transcript scan, activity poll and every wait in its retry
  loops were exactly the chained timers that rule applies to. With the prime testing its game in
  a tab beside its chats, each worker chat took two to three minutes to report an answer that had
  long finished, the prime waited for reports that never came, and nothing moved until the tabs
  were clicked through by hand. Every wait in the recorder now goes through a scheduler Chrome
  keeps on its ordinary once-a-second schedule, and a tab brought back in front re-reads its
  transcript at once.
- **A tab or window shortcut is refused in a browser window.** The prime, driving its game in a
  tab beside its ChatGPT chats, closed its own chat mid-turn with ctrl+w and later walked the
  worker chats with ctrl+tab and typed a URL into one. A keyboard chord cannot see which tab it
  lands on, so the `computer` tool now refuses the chords that close, open or switch tabs or
  windows, or take the address bar, whenever the keys would reach a browser, and the desktop
  instructions say to open the page under test in a browser window of its own. The macOS spellings — command+w, command+shift+], command+l and the rest —
  and macOS application names such as "Google Chrome" and "Safari" count too.
- **A compacting chat whose stream dies is reloaded on the next sweep, not after five minutes.**
  While an automatic Compact & Resume owned a chat's recovery clock, the page's own "Connection
  interrupted" was ignored entirely, and the prime sat on that error for nine minutes while its
  model went on calling tools behind the dead page. The failure now brings the ticket's next
  pickup forward — the same reload, under the same three-attempt bound.
- **A brief lost from the composer before Send is offered to a fresh chat, and the chat it was
  lost from records what you type next.** With the replacement chat open and the brief just
  landed, an Escape in the same instant emptied the composer. The armed ticket then sat for its
  six hours, the run could not move on, and the chat — waiting for a marked message that would
  never come — journalled nothing typed into it afterwards. The page now proves the brief never
  left it (an empty composer in a chat that still has no id), the app takes the armed dispatch and
  the claim back and opens a fresh chat for the same brief at once, and the old page journals
  normally.
- **A chat whose answer stream died is reloaded, every time.** Three separate rules left the prime
  chat dead on "Connection interrupted" for twenty minutes while its answer was long finished on
  the server. The once-per-turn reload budget was charged when the reload landed, against a turn
  that had already failed, so it stuck to the *next* turn and refused that turn's own error as
  already spent. The failed turn's end then took the chat off the two-minute silence watch, exactly
  as a completed answer would, so nothing was left to ask. Now the budget is charged only to a turn
  actually running when the reload lands, a failed turn restarts the silence watch instead of
  spending it, and a reload gives the chat a fresh two minutes before it is judged dead — a worker
  writing a long answer used to be put to sleep, and its prime told to wake it, twenty-seven
  seconds after its own reload.
- **A woken worker is awake when its turn starts, and nothing can put it back to sleep on the
  way.** Waking two sleeping workers at once, the browser typed both messages within a second
  and both pages reported "turn started", yet both stayed *waking* because only a tool call
  counted as proof, and those calls' page evidence was late. In the same second the page
  re-reported the settled answer that had put each worker to sleep, and the app took that as a
  fresh finish: the worker went back to *sleeping* and its wake command was retired, while the
  message the browser had just typed ran as a turn the app did not own. A turn that begins after
  the delivered wake now ends the wake like a call does, and no stop observed from outside — a
  re-reported answer, a late finish call, a quiet sweep — applies while a worker is waking.
- **A refused call from a replaced chat says what it is.** After Compact & Resume, ChatGPT can keep
  running the old chat's stopped turn for a while, and every tool call it makes is refused as
  superseded and filed under Unattributed activity. Those rows now carry a line explaining that
  the request id proved exactly which chat it came from and that nothing needs repairing, instead
  of reading like the attribution chain had broken.
- **The bootstrap fold names the worker and no longer lurches.** The folded opening message of a
  worker chat now says "This is worker-3 — …", from the session's durable origin so a reloaded tab
  still knows, and keeps the first two lines of the text visible while closed so the bubble is the
  same width open and closed.
- **A Compact & Resume is one timeline row again, and it says where it stands.** The card keyed
  its fold on the brief request's own turn id, but the app types that request, so the live
  recorder writes it without one; the answer turn, the brief, the handoff line and the turn end
  then fell out of the card as loose rows. The card now takes the turn that opens right after the
  request. Its three overlapping step pills — which shared a class name with the setup wizard's
  steps and inherited that layout — are replaced by one sentence: what happened, what is still
  happening, or what failed and why. Green once the new chat opened, red once a step cannot come.
  When the app abandons a continuation it records the reason into the session, and the row shows
  it ("Failed — the handover never landed and was given up on").
- **A compaction stuck writing its brief is reloaded every five minutes, for a quarter of an hour
  at most.** The automatic pickup used to wait fifteen minutes before its first reload and
  fifteen between each of the three, so one glitched page cost forty-five minutes of nothing.
  While the brief is still being written the checkpoint is now five minutes; once the brief has
  landed the five-minute clock stops and opening the replacement chat keeps the quarter-hour
  cadence its command is leased for.
- **Reopening an old resumed chat no longer silences the tab.** The marked resume message raised
  the content script's journal gate, and only a committed continuation ever released it. Once the
  app had forgotten that token — after a restart, or simply later — its `no_such_continuation`
  refusal left the gate shut for the life of the document, and the gate followed the tab into the
  New Chat opened next. That chat lost its first user message, its ChatGPT title and its
  `turn_start`, so the app never saw it working: no automatic compaction, no unattributed-call
  recovery, no reload repair, until the tab was refreshed by hand. A definitive app answer now
  releases the gate, and moving to another chat drops the previous chat's gate outright.
- **A reloaded tab records a turn the app never heard of.** A reload mid-turn used to adopt the
  app's open turn or nothing: with no durable turn and no send receipt, the reloaded page filed
  the running question as history, and the chat stayed "idle" for the app while ChatGPT worked
  on. A document that has opened no generation of its own now claims the newest user message as
  the running turn once Stop has outlasted the settle window and the app reports no active turn.
- **A resumed chat is armed the moment Compact & Resume commits.** The new chat used to get its
  activity grant only after it had proved a turn of its own; when it never got its first tool call
  through, nothing knew it was mid-turn and nothing reloaded it. Its calls stayed Unattributed and
  the loop stalled on the first call after every automatic compaction. The commit now grants the
  replacement chat the same silence and unattributed recovery an ordinary working chat has.
- **A retired chat's late observations no longer mint a session of their own.** The old chat
  re-rendering the brief seconds after the commit created a second session consisting of nothing
  but the summary. Such observations are filed into the session lineage they came from, without any
  activity, turn or Goal effect.
- **The Activity log survives the run.** It was in-memory only, so a failed overnight run left
  nothing to read. It is now mirrored, redacted as before, to `app.log` in the app's data folder
  (4 MB, one rotation).

### Changed
- **One Compact & Resume is one timeline row.** The brief request, the brief, the "handoff saved"
  line and the bootstrap in the new chat fold into a single expandable card whose header shows the
  three steps as coloured chips — summary requested, summary received or not, new chat opened or
  not — so a failed handover is recognisable at a glance instead of being three long messages.
- **Unfolded tool rows stay put while a chat is running.** The timeline used to be rebuilt from
  scratch on every change, closing whatever the user had expanded and jumping the scroll position.
  Rows whose record did not change are now kept as the same nodes.

### Security
- macOS Screen Recording and Accessibility remain independent OS grants. The helper requests no
  privilege at startup, reports a typed error when a live operation lacks consent, and permission
  revocation remains effective without changing the connector schema cached by ChatGPT.

</details>

## [2.0.2] — 2026-08-26

2.0.2 is the native cross-platform release port. The already-published 2.0.1 release remains the
historical Windows hardening release; this patch moves the unreleased tree forward so the new
Windows/macOS/Linux build matrix can be published under a fresh tag instead of trying to replace it.

### Added
- **Native release jobs now cover six host/CPU combinations:** Windows x64 + ARM64, macOS Intel +
  Apple silicon, and Linux x64 + ARM64. Every package job verifies it is running on the requested
  native host before packaging and smoke-tests the packaged native runtime before upload.
- **macOS ships DMG and ZIP artifacts for both architectures.** CI verifies each ZIP, verifies and
  mounts each DMG, and checks the resulting `.app` bundle, executable and `Info.plist` before the
  release candidate is assembled.
- **Linux ships AppImage and DEB artifacts for both architectures.** The DEB is installed on the
  exact Ubuntu 24.04 runner that built it. The AppImage is launched normally under Xvfb with an
  isolated first-run profile, then launched again with the static launcher's user-namespace probe
  forced to fail so the documented `--no-sandbox` fallback is covered independently. Both launches
  must reach app, window and renderer-state readiness; native dependencies are executed separately
  from the unpacked package before either artifact smoke.
- **Target-native runtime payload staging now spans all release platforms.** Sharp/libvips,
  node-pty, tree-sitter, tunnel-client and ripgrep are selected and validated for the target OS/CPU
  instead of inheriting whatever native payload happened to be installed on the packaging host.

### Changed
- **Linux packaging is Noble-compatible and keeps stable public filenames.** DEB dependencies allow
  Ubuntu 24.04's time64 GTK/AT-SPI package names, AppImage uses electron-builder's static 1.0.3
  runtime rather than depending on legacy FUSE2, and public artifacts remain `x64`/`arm64` even
  though individual Linux packaging formats use different native architecture aliases internally.
- **Linux desktop identity is explicit.** `desktopName` and `StartupWMClass` now share the
  `com.chatonsteroids.app` identity so installed launchers can associate the running Electron window
  with the generated desktop entry.
- **The app packaging icon is generated at 1024×1024** for Retina-quality macOS ICNS conversion;
  the Chrome extension keeps its existing 16/32/48/128 icon set.
- **Release publication fails cheap.** Tag/version mismatch, missing reviewed notes, public-history
  privacy failure and an already-existing GitHub release are rejected before the six native package
  runners are allocated. Candidate artifact names are run-id based so branch names containing `/`
  cannot invalidate the final upload.

### Known release caveat
- **The macOS DMG/ZIP artifacts are currently publisher-unsigned (no Apple Developer ID) and
  unnotarized.** Apple-silicon Mach-O executables can still carry ad-hoc platform signatures; those
  do not identify a publisher or establish Gatekeeper trust. The native builds and archive/runtime
  checks are covered by CI, but Apple Developer ID signing/notarization is not configured in the
  release workflow yet, so Gatekeeper may warn when those artifacts are opened.

## [2.0.1] — 2026-08-25

This is the post-2.0 hardening pass. It is unusually broad because it combines the reusable-worker
rewrite, a live transcript/Goal investigation, session-store recovery work, the first Computer Use
overhaul tranche, and an adversarial restart/race audit.

### Added
- **Workers are reusable ChatGPT conversations.** A worker that finishes normally now sleeps,
  preserves its full conversation/history and frees its worker slot. `agents action=message` wakes
  a sleeping worker in that same chat. If the tab is still open the extension reuses/focuses it;
  if it was closed the app reopens the exact stored `/c/<conversation>` and types the prime's new
  instruction as a real user message. Waking requires a free worker slot and fails before queueing
  or typing when no slot is available. A worker becomes permanently non-revivable only after its
  recorded context reaches the 400k worker ceiling and it next stops.
- **Worker revival is crash-safe and durable.** Revival has its own browser command, exact
  conversation fence, durable lease, receipt replay, app-restart restoration and browser ACK
  recovery. Browser redemption is now the arbitration cut: once a page owns the durable wake,
  concurrent MCP liveness cannot steal or duplicate it.
- **Worker ownership now survives the active run itself.** When the final slot-holding worker
  sleeps, the global run is parked immediately so another prime chat can start workers, while the
  original prime retains its complete worker history, exact conversation bindings and revival
  authority. `agents status` is caller-scoped, fresh workers can be spawned without consuming old
  sleepers, same-named workers from different primes stay isolated, and Compact & Resume transfers
  the complete dormant/active history to the resumed child chat. Turning Multi-agent off now parks
  live execution and withdraws worker browser commands without deleting those histories; disabled
  restarts preserve them, and only explicit Clear swarm discards the retained ownership.
- **Specific Goals are durable per-chat state.** Reopening a finished chat restores its goal text
  without auto-firing stale work; Compact & Resume transfers the same objective to its child,
  including crash-recovery repair, so an unattended chain of resumptions keeps pursuing one goal.
  A Goal completion decision stops the current loop without silently deleting the user's saved
  objective; it remains until explicitly cleared or replaced.
- **`exec_command` accepts `cmds`** for up to 20 related commands in one shell session, preserving
  variables/cwd between items and returning labeled per-command exit codes. `max_output_tokens`
  controls the model-facing output budget, and `write_stdin` keeps the same bounded semantics.
- **Desktop observations keep immutable recent screenshot frames and UIA snapshots.** Semantic
  refs point at cached AutomationElement handles scoped to helper generation/snapshot identity,
  coordinate actions require retained frame identity, and batches expose exact partial-completion
  and route evidence. Same-call verification can wait for foreground/window/UI conditions and
  optionally capture the resulting state.
- **Retained session history is paged in the Chat UI.** The session list now reports the real
  retained total, loads older pages on scroll and uses cursor deltas for live detail refresh
  instead of repeatedly resending the same large tail.
- **Approved roots can be renamed from the Home UI.** The editor survives unrelated renderer
  pushes, keeps failed drafts for retry and cancels if authoritative state removes or renames the
  target.

### Changed
- **Desktop automation's hot path was overhauled without expanding the public two-tool surface.**
  The helper is prewarmed only when native Desktop capabilities are published, fixed sleeps were
  removed from common focus/action paths, window/UI/pixel acquisition can use one internal
  snapshot request, UIA traversal is bounded with TreeWalker + CacheRequest, and read-only window
  capture tries a background path before any visible-screen fallback.
- **The tested bundled `tunnel-client` now wins by default.** An explicit configured binary still
  wins; PATH/common-install copies are fallback only. Tunnel discovery/version checks are cached,
  and the development bundled path now resolves the repository resource correctly.
- **Windows command startup is cheaper and more deterministic.** Explicit short yields are honored
  instead of being clamped to ten seconds, default PowerShell starts without the user profile,
  shell discovery is memoized, and Java/Go PATH reachability checks are cached against the exact
  environment while explicit `JAVA_HOME` / `GOROOT` keep priority.
- **Browser setup now follows actual feature dependency.** The extension is required only when
  recording or multi-agent is enabled. Durable pairing and live browser presence are separate
  states, so a stored token alone no longer makes Setup claim the extension is currently connected.
- **Filesystem-root setup uses the capability set that really needs a root.** Mixed Core/Desktop
  configurations cannot skip folder approval merely because Desktop is enabled, while genuine
  screen/control/clipboard-only setups remain allowed without a filesystem root.
- **The main window adapts to the current Windows work area** instead of forcing a fixed 1080x700
  non-resizable surface that can exceed small or DPI-scaled displays.
- **Session retention is continuous rather than startup-only.** It runs immediately, then on a
  coarse six-hour singleflight interval, honors the current retain-days setting and scans the
  uncapped attachment catalog instead of an arbitrary first 5,000 directories.
- **Goal configuration is internally consistent.** Recording-off forces Goal off instead of
  persisting a combination that cannot ever supply a transcript. A specific goal can still open a
  New Chat and become its first user message, but an unsent opening goal is never attached to an
  unrelated existing chat navigated to while the provider request is in flight.
- **The stock Goal continuation prompt is slightly more persistent.** It now continues while a
  concrete requested task or question remains unreported/unanswered and stops only when ChatGPT
  clearly presents the whole requested job as complete. It still treats an explicit all-done claim
  as authoritative and does not invent extra testing, polish or follow-up. Existing installs whose
  saved prompt is byte-for-byte the old stock default migrate automatically; edited prompts do not.

### Fixed
- **Quitting always quits.** Quit could hang forever: the app kept running with its window and
  tray already gone, still holding the single-instance lock, so every later attempt to start Chat
  On Steroids silently did nothing and the only way out was Task Manager. Two independent faults
  produced it. The first was logging: Electron keeps a `BrowserWindow` object after destroying the
  window, so the renderer push read `webContents` off a corpse and threw — and because log
  listeners run synchronously on the writer's stack, every teardown log line threw into the
  teardown step that wrote it. The MCP drain's force-close timer died on its own warning before it
  could force anything, leaving the app draining a half-closed tunnel socket with no deadline left
  to save it. The second was the quit itself. Teardown ended by calling `app.quit()` from the
  promise continuation that finished it, and Electron drops a quit raised from there: measured on
  Windows, that call returns without even emitting `before-quit`, while the identical call one
  macrotask later quits normally — so a clean, fully drained teardown still ended in a process that
  would not leave. Renderer pushes now check for a destroyed window, a failing log listener can no
  longer break the code that logged, the two force-close paths act before they report, and teardown
  is both bounded and terminal: each phase has its own budget, and the sequence always ends in
  `app.exit(0)`, which has no such veto.
- **Quit no longer pauses for fifteen seconds on the extension's own connection.** The bridge
  swept for idle connections once when it stopped, which cannot see the request that is in flight
  at that instant — and the extension polls constantly, so on a real quit there almost always was
  one. That socket returned to keep-alive idle when its response finished and nothing looked
  again, so every quit waited out the full 15s force timeout. The drain now keeps sweeping, and
  retires the socket the moment its request is done.
- **Terminal sessions no longer outlive the app on Windows.** node-pty's ConPTY backend reports a
  pid of `0` until its console pipe connects, well after the spawn path recorded it, so every tty
  session carried pid `0` for life: `list_processes` advertised a pid nobody could act on, and
  termination skipped `terminateProcessTree` under its own `pid > 0` guard — leaving the shell and
  its console host alive whenever node-pty had deferred its internal `kill()`. The pid is now read
  live, and terminating every session at once skips the ones already gone, runs the rest
  concurrently and no longer abandons the queue behind a single rejection.
- **Crash recovery no longer trusts stale `meta.json` over newer durable history.** Read-only
  session listing, handoff lookup and normal reopen paths reconcile event/message high-water state
  without incorrectly marking historical sessions live.
- **Request-correlation freshness now behaves like LRU rather than FIFO.** Re-observing a still
  active request id refreshes its bounded-map order as well as its timestamp, preventing exact
  ownership from being evicted behind genuinely stale ids.
- **Expired continuations and worker revivals cannot manufacture a fresh lifetime on restart.**
  Recovery settles the durable broker/continuation half before pruning transport state and uses a
  plan -> reconcile -> one durable rewrite -> publish transaction so overlapping traffic cannot
  persist a half-restored generation. Duplicate same-worker revival rows select the newest valid
  transport before expiry is applied.
- **Bridge stop/start no longer leaves stale singleton callbacks active.** Spawn/revive/swarm-end
  listeners are disposed with the bridge; workers created or woken while the bridge is stopped are
  replayed only after a fresh start owns the callback again. Retained leased commands also have
  their original deadline re-armed after restart.
- **A worker wake cannot be duplicated by browser/MCP overlap.** Existing-tab reuse claims the
  command before the fallback tab is removed; in-flight MCP calls across the revival ACK cannot
  consume/re-offer the wake text; wrong-chat and stale-run ACKs fail closed; lost ACKs replay from
  durable receipts rather than typing a second user message.
- **Worker finalization retires the right delivery state and preserves final reports.** A settled
  reusable worker sleeps instead of becoming terminal, stale offered inbox rows do not reinject on
  the next wake, detached silent workers are maintained periodically even without another MCP
  ingress, and the run is not released while a final worker report still needs delivery.
- **App-side browser Disconnect now means disconnect.** The extension cannot silently pair itself
  again on the next request; only an explicit browser Connect/Retry clears the durable intent latch.
- **Recovery extension downloads are pinned to the installed app version** instead of following
  `releases/latest` and potentially manufacturing an app/extension protocol mismatch.
- **Historical Overwrite no longer fights ChatGPT virtualization while the user scrolls.** Scroll
  input temporarily freezes presentation rewrites and the first idle repaint anchors/compensates
  the actual transcript scroller, keeping the visible historical turn stable.
- **Final assistant turns are recorded and noticed more reliably.** Hidden/background tabs react
  immediately to the generating -> quiet edge instead of depending on a throttled transcript
  debounce; Stop removal outside the transcript wakes the recorder; and when healthy Fiber omits
  `end_turn`, a fresh completed-message action may close the exact terminal sibling only after the
  quiet window, settled calls and generation ownership all agree. Old Copy buttons, Retry/reused
  turn ids and earlier siblings cannot certify newer prose.
- **A transient `interrupted` marker no longer holds a separately proven final response open until
  the user types again.** The recorded outcome remains interrupted, but exact terminal action
  evidence can provide the missing boundary. User-pressed Stop remains excluded from Goal.
- **Only the exact terminal Fiber message is promoted to final.** Commentary or other interim
  assistant rows remain streaming when a turn ends without terminal evidence, and live assistant
  chronology uses the local observation clock rather than a skewed ChatGPT `create_time`.
- **Image/file attachment ids no longer make a real user-text anchor ambiguous.** Overwrite joins
  only against durable authored user-message ids, preventing attachment objects in the same turn
  from splitting or misrouting reconstructed activity.
- **Recorder takeover now removes every ownership channel.** In addition to DOM/window listeners
  and MutationObservers, the predecessor unregisters `chrome.runtime.onMessage` and
  `chrome.storage.onChanged`; an `alive=false` recorder cannot answer a health/revival message or
  repaint after its successor owns the document.
- **Browser journal loss markers keep exact routing identity.** Queue pressure/rejection gaps retain
  the source conversation/provisional/agent/command route instead of borrowing another entry's
  identity, and losses are bucketed per route rather than collapsed across chats/workers.
- **`view_image` no longer serializes the same base64 twice.** Native MCP image content is the one
  transported copy, allowing the full bounded image budget without redundant structured output.
- **Desktop output is bounded where it previously was not.** Clipboard reads are capped per action
  and in aggregate; `observe what=windows` uses bounded `max_elements`; partial action batches
  report the exact completed count and failing index.
- **Ordinary MCP Disconnect cannot force-close an already accepted mutation before its response.**
  Endpoint stop drains gracefully by default; only final application shutdown opts into the
  bounded force-close deadline.
- **Renderer secret/settings races no longer erase newer user input.** API-key fields clear only
  after successful storage and only if they still contain the submitted snapshot; whitespace-only
  OpenRouter input cannot remove a stored key; rapid read-only/theme toggles derive from the latest
  requested settings snapshot rather than stale acknowledged state.
- **Setup and Chat history no longer pay repeated full metadata scans.** A process-lifetime summary
  catalog, bounded initial detail tail and sequence cursor deltas keep live refresh proportional to
  new work while preserving chronological paging across bursts.
- **Dead/unfinished paths were cleaned up.** The stale `--connect-on-start` self-update handoff was
  removed because no updater produces it, and seven file-local extension helpers with no normal or
  reflective caller were deleted.
- **`exec_command.cmds` no longer trusts command-authored text as batch framing.** Each batch now
  carries a fresh random framing id, so a command printing text that looks like an exit marker
  cannot close its section early and corrupt per-command failure classification.
- **A transient session-root filesystem error cannot poison the process-lifetime session index.**
  Only a genuinely missing sessions directory is treated as empty; `EBUSY`, `EACCES` and other
  scan failures fail closed and retry on the next lookup instead of making ownership, retention and
  latest-handoff discovery blind until restart.

### Validation
- Release-index gate on 2026-08-25: public-history privacy check and TypeScript typecheck passed,
  **50 committed Vitest files passed with 1580 passed / 1 skipped**, and `npm run build` produced
  the main, preload and renderer production bundles successfully. A broader local run that also
  included intentionally uncommitted standalone regression files passed as well.

### Known compatibility debt
- `exec_command` / `write_stdin` still represent command output in both the ordinary text content
  and the required structured Codex-compatible `output` field. Both copies are bounded, but
  removing either is an end-to-end contract change rather than a safe local optimization.

## [2.0.0] — 2026-08-24

The first release to carry the goal loop, and the release where the compiler stopped treating
unused code as a matter of taste. 2.0 supersedes 1.9.9, which was tagged in the repository but
never published.

The version number moves to 2.0 because of what changed underneath rather than what appears on
screen: three modules that production no longer reached were deleted outright, `exec_command`
started refusing shell text it previously ran against the wrong filesystem dialect, and two
process launchers stopped handing connector credentials to their children. An integration built
against the removed internals, or against the old pass-through behaviour, will notice.

### Added
- **`noUnusedLocals` and `noUnusedParameters` are on permanently.** They were what surfaced the
  dead code below, and leaving them optional is what let it accumulate.

### Removed
- **`patch.ts`, `patch-files.ts` and `process-manager.ts` are gone**, with their suites. Codex's
  applier and the desktop helper's retirement barrier had already taken over both jobs; what
  remained was a second implementation nothing called, which is the kind of thing that gets
  edited during an incident because it looks live.
- Unused production imports, dead editable-text snapshot and encoding helpers, a dead line-count
  wrapper, and two dead MCP formatting exports.

### Fixed
Credible leads that were reviewed but not reproducible enough to fix are tracked privately rather than
published, as `SECURITY.md` and the documentation rule in `AGENTS.md` require.

- **A patch that moved a file onto itself deleted it.** `apply_patch` writes the destination and
  then removes the source, so equivalent spellings — `source.txt` and `./source.txt` — wrote the
  new contents and immediately unlinked them. Move verification now compares resolved identities,
  case-insensitively on Windows, and refuses the whole patch before anything is mutated.
- **A workspace-relative glob starting with `*` searched a virtual root instead of the chat's
  workspace.** With no literal prefix before the first wildcard, the walker substituted `/`, so
  `*.ts` and `**/*.ts` quietly asked a different question and answered it successfully. An empty
  prefix now stays relative unless the pattern itself began with `/`.
- **`read` charged compressed image bytes against its output budget instead of the base64 it
  actually emitted**, so an image under the `view_image` ceiling could slip past the 512 KiB
  aggregate cap. It now charges the real payload, and a large image gets an explicit `use
  view_image` fallback rather than a truncated answer.
- **A malformed Goal SSE record could be typed into the composer as a finished reply.** Non-JSON
  `data:` records after valid deltas were ignored, and EOF then promoted the partial sentence to
  a message. A non-empty malformed record is now a protocol failure: the stream is cancelled and
  no draft is exposed. Comments, blank lines, role-only events and `[DONE]` are unaffected.
- **Three bridge routes used the capped UI list as an ownership index.** Manual Compact & Resume,
  automatic compaction and Goal draft startup all searched `listSessions()`, which is capped for
  display, so a valid older conversation came back `session_not_recorded`. All three now go
  through the durable attachment catalog.
- **Unsolicited state pushes erased Chat settings while they were being edited.** Home controls
  had a focused-dirty guard and the Chat sheet did not, so a connection or status push could wipe
  a half-typed compaction threshold, worker count or Goal setting. The Chat controls now apply the
  same focused-and-different rule.
- **`shell.openPath` failure was reported as success.** Electron resolves it with an error string
  rather than rejecting; the handler discarded the string and the renderer said the folder had
  opened. Any non-empty result is now an IPC error.
- **Virtual app paths inside shell text ran against the wrong filesystem dialect.** The sandbox
  had a bounded detector for this and nothing called it — PowerShell reads `/workspace/file` as a
  drive-root path, not the app's approved virtual root. `exec_command` now refuses approved
  virtual-root tokens and names the two fallbacks that work. URLs, language fragments and
  unapproved `/name` tokens are left alone.
- **A post-start desktop-helper error released the input queue before the helper was retired.**
  Malformed replies, write failures and timeouts already waited for the process tree to die; the
  child's `error` event rejected immediately, so a replacement could start while a broken helper
  still held desktop-input authority. That path now shares the retirement barrier.
- **Renderer redirects were not vetoed.** Both Electron guards blocked `will-navigate` and
  neither blocked `will-redirect`.
- **`swarm:clearAgent` accepted any string** — arbitrary length, control characters — before
  handing it to the global broker. The IPC boundary now requires 1–64 alphanumeric or hyphen
  characters.
- **Fiber skipped readable assistant sections that had no `data-turn-id`.** The selector required
  the attribute although the state machine handled `turnId: null`; the fixture installed an empty
  attribute instead of omitting it, so the gap was never exercised. A second logical-id collision
  could also swallow a distinct message, and now falls back to the raw message id marked
  unstable — trading reload durability on that one ambiguous row rather than dropping a message.
- **`execRecoveryHints` blamed causes the command did not contain**, suggesting backslash quoting,
  glob expansion or `&&`/`||` fixes for commands with none of them, and printed `Command failed  a
  command` with a doubled space.

### Security
- **Tunnel children inherited ambient connector credentials.** The OpenAI tunnel client spread raw
  `process.env` and cloudflared inherited the environment implicitly, so starting Electron from a
  credential-bearing terminal passed unrelated provider secrets into both. Both launch paths now
  use the shared `childEnv()` scrubber, and the OpenAI path adds back only its own control-plane
  key, the local MCP URL and its discovery headers.

## [1.9.9] — 2026-08-24

### Added
- **The goal loop.** A second model reads each finished ChatGPT answer and writes your next
  message for you, until it decides the thing you asked for is done — at which point it writes
  nothing at all. Off by default, and it needs an OpenRouter API key, which is the one
  credential in this app a *model* can cause to be spent.

  The work is split where the trust boundary is. The page owns the one judgement only a browser
  can make: that the turn is really over. It is the same four-signal barrier a compaction brief
  waits on — the stop control gone, the answer no longer growing, the tool rail still, and the
  app reporting no local call open — held for eight seconds, because a reply that fires early
  types "what about the tests" into a chat that is still in the middle of writing them, and the
  model then answers it as if it were a correction. Everything after that is the app's: the
  context, the key, the request, and one draft per generation.

  What leaves this machine is only the user's messages and ChatGPT's final answers. Not tool
  calls, not their results, not the interim commentary a turn produces while it works — a
  recorded session holds file contents and command output, and none of that is anybody's next
  chat message. The model is asked to write the way you write: lowercase, casual, one message.
  When the goal is met it answers `NO_REPLY` and nothing is sent.

  The reasoning level is selectable (default/minimal/low/medium/high) and the model is chosen
  from OpenRouter's own catalogue, newest release first, twenty at a time — fetched when you
  open the picker rather than when you open the settings.

- **A settings sheet on the ChatGPT composer.** The compaction button is a gear now. Hovering
  still says what is on in one line — `Auto-compaction on, from 300k tokens` / `Goal on` — and
  clicking opens a small sheet in ChatGPT's own type, hairline and radius, with a switch each
  for automatic compaction and the goal loop, and *Compact & resume now* as the sheet's single
  action. The switches write to the app and paint what the app answers back, never optimistically,
  because the app's own settings window can change the same two. With no key stored, the goal
  row reads `OpenRouter API key essential for goal feature`.

- **The panel above the composer says what the loop is doing** — checking the answer is
  finished, sending it to OpenRouter, the model's reply streaming in as it is written, then
  either the message about to be sent or `Goal reached · nothing was sent`. A failure shows its
  code (`out_of_credit`, `auth_rejected`, `rate_limited`, `http_502` …) rather than going quiet.

- **`ultrathink` on the worker bootstrap.** A worker is the one agent here that gets a task with
  no conversation in front of it and no chance to ask a clarifying question, so the one thing
  worth spending a token on is asking it to think before it starts.

### Fixed
An audit of the merged tree checked ordering at the crash, reload and navigation boundaries, where
several of these were correct a second later and wrong at the moment a caller decides whether its
operation happened.

- **A patch that touched one file twice was refused, though the applier behind it would have
  taken it.** `apply_patch` runs Codex's verifier as a pre-flight gate in front of Codex's
  applier, and the two disagree about a patch whose hunks name one path more than once. The
  verifier keys its preview by path and rejects the repeat outright with `multiple operations
  target …`; `apply_hunks_to_files` walks the hunks in order and writes each one before it reads
  the next, so a file updated twice — or rewritten as a delete followed by an add — applies
  exactly as written. Upstream never has to reconcile them because that verifier was built for an
  approval UI, where a repeat would silently drop an entry from the list shown to the user.
  Nothing here shows that list; the gate just refuses. Three of seven hundred and two recorded
  patch calls died that way: one test file carrying two `*** Update File:` headers where one
  header with both `@@` chunks was required, and two documents the model meant to replace
  wholesale.
- The gate itself earns its place — it is what makes a patch whose last hunk has stale context
  fail before the earlier hunks have been written, which is the difference between a refusal and
  a half-patched tree — so it now stops disagreeing with the thing it gates rather than being
  removed. Verification carries what each earlier hunk would have left at a path, and every later
  hunk on that path reads from there instead of from disk: the dry-run equivalent of the write the
  applier does in between. A repeat is refused only where the applier would also have failed, with
  the reason it would have failed — an update after the patch deleted the file, or a second hunk
  whose context is stale against the first one's result, both of which are now reported as what
  they are. This is sequential and not a merge: the second update may edit a line the first one
  inserted, and may sit earlier in the file than the first, both of which the single forward cursor
  shared by chunks under one header would refuse.
- **A diff capped with `Select-Object -First` was reported as a failed command.** The stage stops
  the pipeline the moment it has its N objects, which kills the program still writing into it and
  leaves a non-zero status behind — `git diff | Select-Object -First 5` exits 1 where the same
  `git diff` exits 0, and whether it bites at all depends on how much the program had left to
  write. One worker capped a four-file diff at 220 lines, got 383 lines of correct diff under
  `Process exited with code 1`, and ran it again. The exit is now called what it is, but only
  where nothing else could have caused it: the pipeline has a truncating stage and no stage that
  could have set the status itself, the generator is a git subcommand that only reports and
  carries no `--exit-code`, `--quiet` or `--check`, and the run printed something without printing
  a `fatal:`. Rule out the cut and there is no way left for that command to have exited 1. A test
  run capped the same way is untouched, which is the case this must never get wrong, and the note
  hands over `-Wait` as the way to keep the status meaningful.
- **A search that named one missing path threw away the answer for the others.** ripgrep given
  three files where one does not exist prints `os error 2` for that one, prints every match from
  the two that do, and exits non-zero. A prime agent read the status, dropped the matches, and
  went looking again — for a file it had misspelled by one directory. The output now carries a
  note saying which path was missing and that the rest is a complete answer for the paths that
  exist. Distinct from the unexpanded-glob note above it, which is `os error 123`: a path that
  could not exist, rather than one that merely does not.
- **A bash-style escaped quote made PowerShell refuse the whole line.** A backslash escapes
  nothing in PowerShell, so `rg -n "a|state === \"starting" src` ends its argument at the
  backslash and the shell rejects the line with `TerminatorExpectedAtEndOfString` — running none
  of it, including the `git diff` two statements earlier on the same line. In one recorded
  session that was two of a worker's forty-six calls, each returning 49 tokens of parser error
  that never mentioned the escape character. Such an argument is now re-quoted with single
  quotes before it runs, but only where the line provably does not parse as PowerShell, does
  parse under bash's rules, and parses again once repaired. The backslash itself is kept: the
  two escapes PowerShell does accept both parse and then hand the program the quote stripped and
  the following argument swallowed into the first, which was verified against the shell — a
  wrong answer reported as a successful one is the thing this must never do. A body holding
  `$`, a backtick or a doubled backslash is left for the shell to refuse, with a new hint that
  names the cause.
- **A search that found nothing still read as a failure.** The classifier that knows exit 1 from
  `rg` is a result and not an error was spent only on the session's error count, so the model
  still saw `Process exited with code 1` under an empty body and re-ran searches that had
  already answered. It now says so in the result itself, for both shapes that produce it: no
  matches, and a pipeline stopped early by `Select-Object -First`.
- **The settings sheet pushed its own controls off the right edge.** `.pane` is a grid, and a
  grid with no explicit column gets an implicit `auto` track — which is floored by the widest
  child's min-content width. The settings rows carry `white-space: nowrap` hints, so that floor
  was the whole sentence: measured at the window's own 1080px the track came out 724px inside a
  674px content box, and the card clips rather than scrolls sideways. Every row overhung by 50px,
  which ate the compaction switch, the goal switch, the units and the end of "Select model". The
  column is `minmax(0, 1fr)` now, so the rows yield the way they were always written to.
- **"Default" was a 708px dropdown.** The Reasoning select inherited the `width: 100%` written
  for the stacked fields in `.field`, and in a flex row that made a five-word menu as wide as the
  sheet with its own label squeezed to nothing. A dropdown in a settings row is now as wide as
  the word it holds, and the row's button no longer shrinks ahead of the explanation beside it.
- **Two buttons that opened nothing.** `link:open` is an allowlist, so a URL missing from it does
  not open the wrong page — it throws in a handler nobody watches and the button is simply dead.
  "Open OpenRouter keys" had never been added, and "Open Apps" broke when ChatGPT renamed that
  page from Connectors and the markup followed while the allowlist did not. Both work; a test now
  holds every `data-link` in the window against the allowlist, which is what caught the second.
- **The model picker stopped at twenty.** Scrolling the catalogue to the bottom loaded
  nothing: paging was only ever on the "Load 20 more" button below the list, which is not
  where anyone looks when a scrollable list runs out. The list pages itself now, a screenful
  before the end, and the button still works for anyone who prefers it. The repaint was the
  other half of it — the list is rebuilt whole on every page, and emptying an element scrolls
  it back to the top, so even once it paged it threw the reader back to the newest model.

- **The goal loop armed itself in worker chats.** The switch is one setting, but it is the
  prime's. A spawned worker already has an author for its user turns — the prime, through the
  agents tool — so a second model typing into it as well made the worker answer a question its
  prime never asked and finish against that instead, with every worker in the run spending
  OpenRouter credit in parallel on drafts about to be overridden. The loop is now on for the
  prime and for an ordinary chat that is no part of a run, and off for every worker.

- **The default model was a snapshot from April, and the newest ones could not be saved.**
  OpenRouter publishes twelve ids beginning with `~` — family aliases that always resolve to
  the newest model in a family — and the picker lists them because the catalogue does. The
  validator behind *Save* did not allow the character, so the one kind of entry most worth
  choosing was the one kind that reported an error and left the model where it was. The
  shipped default was `deepseek/deepseek-v4-flash`, which reads like "the flash model" but is
  published as V4 Flash 0423; two newer revisions existed by August that the default could
  never have reached. It is now `~deepseek/deepseek-v4-flash-latest`, which cannot rot the
  same way and is the cheaper of the two at $0.04/M prompt against $0.057/M.

- **One ChatGPT answer could be drawn twice, one copy per section.** Overwrite reconstructs a
  response from the user message that caused it, so every assistant section between that
  message and the next one resolves to the same reconstruction. Sections that carry a turn id
  are folded into one logical turn first; sections ChatGPT renders *without* one — which some
  builds do permanently — were not, and each of them painted the whole answer into itself,
  stacked down the page with ChatGPT's own copy hidden underneath each. The first section to
  claim a reconstruction now owns it, and the rest of the response stays behind it.

- **The settings popup and the hover bubble had no fade at all.** Both asked for a
  `clf-pop-in` animation by name and nothing ever defined it. A CSS `animation` naming
  keyframes that do not exist is not an error — it is simply nothing — so the two surfaces
  snapped into place at full opacity beside a page whose own popovers fade. Nothing in a
  browser will ever report this, so a test now asks the stylesheet instead: everything it
  animates, it defines.

- **The goal loop went quiet instead of saying it had given up.** Two of the watch's dead ends
  — an answer with no text in it to continue from, and a turn that never stopped changing
  inside the five-minute ceiling — simply removed the panel, which from the outside is
  indistinguishable from a loop that never ran. Both now say what happened. The failing paths
  also keep the step they failed in rather than collapsing into one `failed`, so a run that
  stopped is drawn where it stopped.

- **A second chat inherited the first one's goal state.** None of the loop's state was cleared
  on navigation, so opening another chat drew the previous one's phase and error above its
  composer — "The goal loop stopped", about a conversation no longer on screen — and carried a
  finished turn's id across as the id the new chat must not draft twice.

- **A retired swarm's worker command could be adopted by the next run.** Worker bootstraps were
  identified by `worker:<agent>`, and `worker-1` is what every run calls its first worker — so a
  durable command left over from run A matched run B exactly, and run B inherited A's task, A's
  command id and A's lease. Commands now carry the broker's run id, dedupe on it, retire when
  their run stops being current, and refuse to be queued outside a run at all. Worker rows from
  the older journal versions are dropped on restore rather than migrated: nothing on disk says
  which run owned them, and the restored broker re-requests anything it is genuinely owed.
- **Lost-ACK worker recovery trusted a label the page chose.** Binding a conversation to
  `worker-1` on the page's own say-so is authority handed to anything that can say `worker-1`.
  The page must now also present the exact command id it redeemed, honoured only against a
  still-leased command of the current run.
- **`session` told a model its history did not exist.** When this app could not place a call in
  a conversation — a request id that never resolved inside the evidence window — `action=history`
  answered *No recorded session is available*, which is false and a dead end: the model concludes
  there is no history and rebuilds the work from the filesystem, which is what happened on
  2026-08-23 against a recording hundreds of events long. It now says what actually happened and
  lists the recordings, so the next call can name one. `action=status` does the same, and a
  history search that matches nothing names the other recordings too — a search that finds
  nothing here is often aimed at the wrong session, since a compacted chat's work lives under the
  id it inherited.
- **`exec_command` could hand a recycled process id to its previous owner.** Process ids are
  small and reusable and ownership lives in a separate registry, so an evicted process could
  leave its owner row behind and let the old chat write to or interrupt the new chat's process
  during the new call's first yield. The row is cleared at the allocation boundary now.
- **A desktop click could land on a screen nobody had looked at.** `frameId` was "strongly
  recommended"; without it, coordinates were applied to whatever the latest global frame happened
  to be — and another chat or agent can replace that frame between the screenshot a caller saw
  and the click it sends. Coordinate actions now require it (`FRAME_REQUIRED`). Semantic refs
  resolve the real control at action time and are unaffected.
- **One unknown reasoning level would have wiped every root and permission.** A rejected enum
  fails the whole settings parse, which collapses the file to conservative recovery. The set of
  levels is a provider's vocabulary, so a config written by a newer build is a case this app will
  meet; it falls back now, exactly as a blank model id is repaired rather than refused.
- **The goal loop would never stop waiting for a composer somebody was using.** Its two-minute
  patience was measured from a timestamp that every retry reset, so it could not expire and the
  draft would have retried for as long as a half-written message sat in the box.

- **A worker's message could reach disk before its sender was told it had been accepted.** The
  broker stages a message and hides it from the recipient until the immediate write succeeds, but
  `changed()` also kicks the ordinary debounced snapshot, and that snapshot still contained the
  staged entry. Its 300ms writer could therefore land while the acceptance write was still held or
  about to fail, so a crash in that window restored a message whose sender had been told nothing —
  or had been told it failed. The broker has two structurally separate views now: the public
  debounced snapshot excludes unpublished messages, and only the private one behind the immediate
  write includes them. A failed write rolls the staging back and emits a committed-only revision,
  so the writer's own generation ordering supersedes the rejected work rather than resurrecting it
  on a later retry.
- **A worker's bootstrap command could be retired before the binding it created was durable.** The
  page redeemed its command, bound its conversation in memory, and ACKed — and a crash between the
  receipt and the swarm fsync left neither a command to replay nor a binding to recover from.
  Persistence comes first now: the ACK may replace a leased worker command with its receipt only
  after the critical snapshot succeeds, and if that write fails the ACK is retryable and the
  command stays redeemable.
- **A worker's final report could be acknowledged before the state carrying it was durable.**
  `/events` recorded a worker's last message, finished the conversation, queued the exact
  worker→prime report and answered 200 — while the terminal broker state behind it was still on
  the debounced writer. The extension retired its observation on that 200, and a crash restored
  the worker as active with the exact result gone, leaving the orphan path to manufacture generic
  completion text in its place. The barrier is crossed before the browser is acknowledged; a
  failure is a retryable 503, which keeps the observation available for replay.
- **A reused worker id could inherit the previous run's project folder.** Worker workspaces are
  keyed by a stable short name like `agent:worker-1`, and `inheritWorkspace()` did nothing at all
  when the new prime had not learned a workspace yet — so the old value under that reused key
  survived into the next run, and a relative path resolved against the previous run's project.
  Inheritance has replacement semantics now: reusing an id clears that worker's old workspace
  first, and the prime's is copied only when there is one.
- **A restored worker could be opened twice, or reopened after it had finished.** Two crash
  windows survived in the journal: a worker bound to a conversation but still recorded `invited`,
  which restore treated as owing a fresh chat, and a once-detached worker persisted as `finished`
  while it still carried `revivable`, which let terminal work reopen. Restore repairs the first,
  a finished worker is never revivable, and binding and activation are one persistence transition
  rather than two.
- **A run could be released while a message was still committing.** Staged worker messages are
  deliberately invisible to the ordinary pending counts until their durability barrier succeeds,
  and `releaseQuiescentRun()` consulted exactly that visible count. In a parallel finish and report
  ACK the visible work could reach zero and destroy the run while a staged `agents action=message`
  was still waiting to commit — and its sender would then be handed success for a message attached
  to a broker that no longer existed. Unpublished messages count as outstanding work for release
  while staying hidden from delivery.
- **An upgrade could restore the weak run fence it had just replaced.** Run identity moved from
  short random hex to a UUID without a snapshot version bump, and restore trusted any `runId` it
  found — so the obsolete 32-bit incarnation id came back and was used to fence fresh durable
  worker commands. A restored run id must satisfy the current UUID-v4 shape; a legacy snapshot is
  re-keyed to a fresh one with its agents, queues and unfinished bootstrap obligations intact.
- **Handoff recovery stopped looking after 5,000 sessions.** `latestHandoff()` promises to search
  every recording, but it reused a directory scanner whose 5,000-entry cap exists for bounded
  maintenance work. Past that count the newest handoff could sit outside the scan, and recovery
  answered with an older one or with nothing. Recovery has its own uncapped summary scan; the cap
  stays where it belongs, on pruning.
- **One state file that failed to write took every later one down with it.** `flushDurable()`
  rejected on the first named file that failed, so at shutdown a broken `swarm.json` write could
  stop an unrelated continuation, correlation or bridge snapshot queued behind it from being
  attempted at all. A shutdown pass now attempts every pending file, preserves failed generations
  for the retry machinery, and surfaces the first real error after the independent writes have run.
- **A restart could answer a completed command's retry with "gone".** The bridge snapshot is
  version 3 and carries the command receipts that resolve a lost HTTP acknowledgement, but restart
  recovery accepted receipts only from version 2. A command whose operation and receipt were both
  durable therefore answered an exact post-restart retry as though it had never happened, instead
  of replaying its committed result. Recovery accepts the current shape as well as the compatible
  older one.
- **Compaction work could follow the tab into a different chat.** Settle and watch work waits on
  tools and browser state, and the browser can navigate A → B, or A → B → A, while it waits. The
  conversation id alone cannot see the second case — the id is the same again while the document
  is not — so stale work could continue against the new document and submit a handoff into the
  wrong navigation. Compaction is fenced by conversation id *and* navigation epoch; navigation
  clears stale capture state, and a cancellation retires its capture before crossing any later
  wait rather than leaving something able to complete after it was abandoned.
- **A rejected handoff was already published as the latest one.** `createHandoff()` wrote the
  handoff file and appended the session `handoff` event before the continuation WAL moved from
  `awaiting-summary` to `awaiting-chat`. When that WAL write failed the continuation correctly
  stayed retryable — but `meta.lastHandoffId` had already exposed the rejected brief to every
  unrelated recovery caller, and the retry could then write a second one. Capture is a two-store
  transaction with explicit ordering now: prepare the file, durably publish the continuation state
  carrying its id, then publish the session event. The opposite crash window — WAL committed,
  session event missing — is repaired idempotently at restart.
- **Goal could send a draft after the switch was off.** The page checked the setting before
  starting a draft, but an OpenRouter request already in flight could come back ready after the
  user switched the feature off, and the send path typed it in anyway. The send boundary rechecks
  the current setting before touching the composer, and the app acknowledging an in-progress draft
  now aborts its request so a cancelled draft stops spending the key.
- **A lost acknowledgement could send the same message twice.** ChatGPT accepting a message is
  irreversible; `/goal/ack` is a fallible local hop. If the send landed and the ACK did not, the
  app correctly re-offered its unacknowledged draft after a reload — and the browser had no record
  that it had already spent that token. The content script writes the conversation and draft token
  into a small bounded `sessionStorage` receipt the moment ChatGPT accepts the send, before it
  tries to ACK, so a reoffered token retries only its acknowledgement. The other half was the
  ten-minute expiry, which deleted the whole draft and with it the key that made this safe: expiry
  retires the visible payload but keeps the turn and token as an acknowledged tombstone until a
  genuinely newer generation supersedes it.
- **Goal could pay for a decision that did not include the answer it was reacting to.** The
  content script accepting an observation means it is durable in the extension's journal, not that
  the app has it. With `/events` mid-retry, a finished answer could trigger a draft and the
  background worker would call `/goal/draft` straight away, against a session still missing that
  answer. Goal joins any in-flight drain and gives its conversation priority until the worker can
  prove there are no accepted-but-undelivered rows for it; if delivery cannot be established it
  returns a retryable `transcript_not_delivered` and never calls the route.
- **A cancellation could retire the wrong generation.** `/goal/ack` also took `cancel:true`, and
  that branch ignored the draft token it was given and cancelled whichever draft happened to
  occupy the conversation — so a delayed cancel from one generation could retire the next. No
  current content code used it. The unkeyed branch is deleted; retirement has one protocol, the
  conversation plus the exact token, which already aborts in-flight provider work and keeps the
  tombstone.
- **A provider could hand this app an unbounded body.** Goal read error responses with
  `response.text()` and the model catalogue with `response.json()`, buffering whatever arrived
  before reducing it to a short status or a picker list. Both go through a streaming byte-bounded
  reader now, enforcing the declared length *and* the actual bytes — 64KiB for a diagnostic
  failure, 8MiB for the catalogue. The cache holds at most 5,000 models, an id over 500 characters
  is refused rather than truncated into a different identity, and display names are capped.
- **The model catalogue outlived the key it was fetched with.** The cache was not scoped to the
  credential, so replacing a restricted key kept the previous key's catalogue for the rest of the
  TTL. It is keyed by a one-way fingerprint of the credential now.
- **A stream that ended without a trailing newline lost its last record.** SSE parsing could drop
  the final record, or split a UTF-8 tail, when the connection closed on a boundary it did not
  expect. EOF flushes the decoder and the last buffered record.
- **A long answer's own revisions could crowd the conversation out of Goal's context.** Canonical
  recordings replace stable messages in place, but older ones can hold many append-only snapshots
  of a single ChatGPT message id, and `readRecentEvents()` counted every revision against its row
  cap — so enough revisions of one long assistant answer filled the whole recent window before it
  ever reached the user turn that answer belonged to. Newest-first scanning counts a stable legacy
  identity once and keeps walking back until it has the number of logical rows it was asked for,
  and Goal collapses same-kind, same-id legacy rows defensively, keeping first chronology with
  newest content and leaving id-less rows distinct.
- **Connect and Connecting could describe resources that were not running.** Four lifecycle
  defects, one surface: after a disconnect a connector card could keep the dead tunnel's `live`
  state and public URL; a terminal report such as `tunnel-unavailable` left the card reading
  "Connecting" forever; changing the active Core transport while connected could leave the old Core
  running while settings and Desktop had already moved to the new one; and the pre-connect folder
  gate disagreed with surface availability, refusing a clipboard-only Desktop setup that needs no
  filesystem root at all. Presentation is rebuilt from the endpoint actually running, terminal
  reports map to a surface error, a Core-affecting change performs a serialized reconnect while a
  Desktop-only tunnel change stays hot-swappable, and the gate uses the same usefulness predicate
  as publication. Connect, disconnect and applySettings are serialized and tunnel callbacks are
  fenced by a connection generation, so a late report from a stopped tunnel cannot repaint the
  connection that replaced it — and the button's own label and action read the same running states
  as the lifecycle owner, so a fast double click cannot become two tunnel stacks.
- **Desktop discovery could freeze Core's tool shape before Core had been asked.** The two share a
  loopback listener but are separate discovery units, and one global exposure snapshot let a
  Desktop discovery fix Core's mutually exclusive `find`-versus-exec choice on Core's behalf.
  Exposed capabilities, features and that choice are monotonic per surface now, which is the
  boundary ChatGPT actually caches.
- **A chunked request had no size limit before it was parsed.** The Content-Length guard did not
  cover chunked or length-less POSTs, so the adapter could concatenate an arbitrarily large body
  and then hand it to the JSON parser. Those requests go through an explicit 8MiB bounded
  collector; bytes past the limit are drained without being retained and answered 413, and
  malformed bounded JSON is answered 400.
- **A history search could report a match and then not show it.** The selector built a small
  neighbourhood around every hit by walking forward from two events before it, and stopped as soon
  as the presentation cap was full — so with `limit: 1` a real hit at event 7 could be answered as
  "1 match" while the response contained event 5 and not event 7 at all. Direct matches reserve
  the budget first; what is left is filled with nearest context in rings and sorted back into
  chronological order.
- **`session` declared itself a writer, and capped recovery below what it can store.** It exposes
  `history` and `status`, both inspection, but advertised `readOnlyHint: false`, so a client could
  reasonably apply write or confirmation semantics to reading this app's own recording. The second
  was arithmetic: a recorded call can legitimately spill around 16MiB across argument and result
  overflow, while the schema stopped `history(call_id)` at part 200 — a valid part 200 could
  instruct the model to ask for 201 and the schema would refuse it. It is marked read-only, and
  the maximum part is derived from the real overflow ceilings rather than a constant that had
  drifted away from them.
- **A migrated root could collide with the reserved namespace.** Legacy and migrated roots could
  land on a reserved virtual name — `/skills` notably — or on another root once names were
  normalized, leaving an ambiguous virtual path. Migration and live rename preserve unique safe
  names, and a live rename into the reserved namespace is refused.
- **`exec_command` rebuilt only PATH.** It started from the raw parent environment with PATH
  replaced, rather than from the sanitized child environment every other spawn here uses, so
  connector and API secrets were not stripped from it. It starts from the shared sanitized
  environment now, which also keeps the bundled ripgrep path and the system paths intact.
- **A read that touched nothing counted as a read that worked.** Multi-read telemetry counted
  targets it never attempted once the output cap was exhausted, and an explicit read whose every
  target failed came back as a successful response full of `ERROR` sections. Only paths actually
  attempted successfully are counted, and the all-failed case is an error.
- **Relative paths could resolve against another chat's root.** Identity-sensitive relative and
  default-workspace operations fell back to another root or chat when the exact calling
  conversation could not be proven. In an active swarm they fail closed instead.
- **A dying page could reopen its navigation lease while its replacement was loading.** Direct
  navigation marks the old document terminal before the new one registers, and the old page can
  still emit a delayed message on the way out. The recovery heuristic read any mismatch with the
  registered document as proof that the terminal prediction had been wrong — even while Chrome was
  reporting a `pendingUrl` for a new ChatGPT document — which let the dying A document reopen its
  lease in the middle of A → B. A terminal prediction is overturned only once Chrome proves the
  original document is settled again; a genuinely speculative one still recovers when the tab is
  stable.

### Changed
- **The compaction window defaults to 400k estimated tokens**, up from 300k, with the red line
  following it to 533k. 300k was set as the point with comfortable room left to compact, and in
  use it turned out to be early: chats sat amber and compacted themselves while nothing was
  wrong with them, and every one of those cost a fresh conversation. 400k is the figure the
  ceiling has actually been observed near, and the trigger has been edge-based since 1.8, so the
  turn that crosses the line still finishes and still writes its handoff.

  It reaches existing installs, not just fresh ones. `auto: true` at 300k is what 1.8 wrote for
  itself, so a config still carrying exactly that moves; the meter's own 300k/400k pair moves
  with it. Any threshold somebody typed stays exactly where they put it, and nothing moves back
  down — a config already at 400k keeps it, however it came to be there.

- **The panel above the composer has a progress bar with named stages.** *Answer settling ·
  Reading the chat · Writing the reply · Sending*, one segment each, filled up to where the
  run is and with the segment being worked on the only one that moves. A caption on its own
  answers "what now" and never "how far", which is exactly the distinction between a run that
  is slow and a run that has stopped — and where a stopped run stopped is now visible rather
  than inferred from which sentence it froze on. Built to ChatGPT's own measurements: a 3px
  track, the accent already used by the switches, labels at low contrast until they are the
  one running. Reduced motion fills the active segment instead of animating it.

- **The goal loop's messages are typed, not written.** Two things give a composed message away,
  and neither survives being asked nicely in a system prompt. The em dash is the first: it is
  not on a keyboard, and one of them in a lowercase two-line follow-up is the whole tell on its
  own. Every one is now replaced by what somebody typing that sentence would have reached for
  instead — a comma, usually; nothing at all when it opened a bullet; a hyphen between two
  digits, because that was a range. The second is that the message is *clean*, and real ones in
  a conversation like this are not, so one or two slips go in: a dropped apostrophe, a collapsed
  double letter, a transposed pair in the middle of a word. Never more than three in a message,
  spread so two never land in the same breath, and never inside backticks, a path, a URL or a
  file name, where a typo is a different instruction rather than a slip.

  None of it is random. One finished turn is one message, and that only holds if a retried
  request, a second observer and a reloaded tab are all handed back the identical string — so
  the choices are seeded from the draft itself and never from a clock. The `NO_REPLY` check
  still runs against what the model actually said, before any of this touches it.

- **The two legacy-heavy suites no longer carry 35 skipped tests.** Thirty of them asserted
  mechanisms that no longer own truth — DOM-row progress ownership, retired commentary
  reconstruction, old local generation heuristics, recorder behaviour that moved into the
  canonical session and Fiber layers — and were deleted rather than cosmetically re-enabled,
  because a skipped test for a dead architecture preserves neither coverage nor a specification.
  The five that still described live invariants were rewritten against the current Fiber and
  navigation-epoch model: a STOP before a new assistant section must not attach the new generation
  to the old one, commentary-only activity may bind the right section while Fiber supplies
  identity, extension-owned rendering must never feed back into canonical recording, an
  unexplained Stop-control dropout must not manufacture an `unknown` turn end, and work arriving
  after Stop reappears stays on the same local generation. The continuation suite was also built
  on synchronous helpers whose mutations were merely debounced, so it could stay green without
  ever exercising the WAL path production uses; it constructs and claims through the durable APIs
  now, and the dead synchronous exports are gone.

## [1.9.8] — 2026-08-23

1.9.7 was tagged and its installers were built and checksummed, but it was never published:
review found four more ways the same two mechanisms could still be wrong. The tag and its
artifacts stay where they are as the record of that commit, and this is the release.

### Fixed
- **Glob and brace expansion actually reach ripgrep again.** Binding a bare `rg` to the bundled
  binary and expanding its globs are two rewrites of the same command, and they were run in the
  order that cancels one out: binding replaced the leading `rg` with `& 'C:\…\rg.exe'`, and the
  normalizer, which recognises ripgrep by that leading token, then saw a command it had no
  opinion about. Every ordinary `rg pattern *.ts` went out unexpanded — the exact failure the
  normalizer exists to prevent — while both halves looked correct in isolation, which is how
  the unit tests missed it: each function was only ever called on its own. Expansion now runs
  first and binding composes on top of it, and the regression exercises the pair together.
- **`JAVA_HOME` is never pointed at a runtime that cannot compile.** Discovery accepted any
  directory holding `bin\java.exe`, and a JRE has one. `C:\Program Files\Java` with `jdk-21`
  beside a leftover `jre1.8.0_411` is what an ordinary Oracle install leaves behind, and name
  ranking falls back to text once two names stop sharing a digit run — so the JRE won, JAVA_HOME
  named it, and its `bin` went to the front of PATH. That is not a worse JDK, it is a broken
  Gradle build on a machine that had a working one. The probe is now for the compiler, so the
  answer is a JDK by construction, and a machine whose only Java is a JRE gets nothing rather
  than a confident wrong answer.
- **A failed command is quoted back in a form that can be run again.** The command echoed in
  `exec_command failed for …` escapes an apostrophe the way shlex does. It had been written as
  a double-quoted JavaScript `"'\''"`, which is three apostrophes rather than the intended
  quote-escape-quote, and three leaves the quoting unbalanced: `'it'''s'`. Glob expansion quotes
  every name it substitutes, so apostrophes in that string are routine rather than exotic.
- **The PowerShell native-search normalizer now fails closed whenever its parser cannot prove
  the command shape.** Backtick escapes are no longer split as if their escaped `;`, `|`, newline
  or whitespace were real syntax; bracket classes such as `a[12]*.ts` are not "expanded" with
  the brackets treated literally; and a leading dot follows shell glob rules instead of letting
  `*.ts` silently include `.hidden.ts`. Ripgrep option arity is no longer guessed from a hand
  table either: the known option set comes from the bundled binary's own help, and an unknown
  option leaves the command untouched rather than risking a pattern/path swap such as
  `rg --engine pcre2 foo.* src`.
- **The exit-1 "no search matches" exemption no longer guesses through shell syntax or profile
  shadowing.** A PowerShell backtick makes the lightweight status parser decline the exemption;
  downstream pipeline stages are skipped only for a very small set of exact passive shapes,
  rather than merely because their names are known cmdlets; and a profile-enabled shell no
  longer treats bare `rg` / `rg.exe` as proof that ripgrep ran. PowerShell can define a function
  under either name — `-NoProfile` included, since a function defined in the command text
  shadows the executable regardless — so a path-qualified executable is the only thing the
  command text can prove, and the only thing that earns the benign-exit classification. The
  ordinary case is preserved rather than surrendered: a bare `rg` is first rewritten to the
  bundled binary by absolute path, which is the same build the option table is read from and
  was already first on the child PATH.
- **A conditional chain no longer donates ripgrep's exit code to whatever actually failed.**
  `&&` and `||` were read as ordinary separators and the last statement taken as the command
  that set the exit code. On PowerShell 7, where those operators work, `cmd /c exit 1 && rg foo`
  never reaches ripgrep at all — and the exit 1 it really came from was filed as a search that
  found nothing. Which branch ran is decided at run time and nothing in the text says which,
  so a command line holding a top-level chain now names no program and keeps no exemption.
- **A wrapper script named after a search program is no longer treated as one.** The program
  name had `.cmd`, `.bat` and `.ps1` stripped along with `.exe`, so `rg.cmd`, `rg.bat` and
  `.\rg.ps1` all answered to ripgrep's contract that exit 1 means "no matches". They are local
  scripts free to exit 1 for their own reasons. Only the program itself — spelled `rg` or
  `rg.exe` — is still a candidate for the exemption, and it still has to be path-qualified
  to actually earn it.
- **A brace group that still needs a glob stage is left alone instead of half-expanded.** bash
  expands braces and *then* expands the wildcards in what came out. Only the first half happens
  here, and what it produces is quoted so it reaches the program verbatim — so `{*.ts,*.js}`
  became two quoted wildcards ripgrep cannot open, a worse failure than the untouched group.
  Any alternative still holding `*`, `?` or a `[…]` class is now refused outright.
- **One chat's tool call no longer holds another chat's compaction open.** The barrier that
  waits for local work to settle before a handoff is written read a count of every call running
  in the process. A swarm runs every chat through that one process, so a worker's long build
  kept the prime's finished brief waiting until the watch expired and aborted the compaction —
  blocked by work it has nothing to do with and cannot see. The count is per conversation now.
  A call whose chat is not yet proven still counts against every chat, which is the same
  conservative answer as before and the only safe one while its owner is unknown.
- **Compact & Resume now fails closed on an unsettled or unobservable local machine, without
  waiting on recorder bookkeeping that cannot mutate it.** If the chat's local request count is
  still non-zero at the settle deadline, or the app cannot provide a valid count after bounded
  retries, no handoff is submitted. A finished unattributed call may still spend the recorder's
  correlation grace window waiting to be filed; `/activity` now exposes that separately as
  `settlingTools` while `pendingTools` means requests still inside dispatch. This removes an
  accidental ~15-second cross-chat compaction tax without turning "could not verify zero" into
  success.
- **Explicit shell requests execute the shell that was actually named or fail before running
  anything.** An unknown/missing explicit shell no longer falls back to `cmd.exe`, and an
  explicit `powershell` is never silently upgraded to `pwsh` (or vice versa). Path-like shell
  values mean that exact file, including relative paths resolved against the command's own
  `workdir`, so shell-language changes cannot hide behind fallback behavior.
- **`read` now reports zero successful explicit targets as a failed call and records the count
  it really read.** Partial multi-read remains useful, but two missing requested files are not a
  healthy read merely because their `ERROR` sections were returned. Targets skipped after the
  aggregate output cap are no longer counted as successful telemetry either.
- **Unified `exec_command` uses the same child-environment contract as the other process paths.**
  Connector/control-plane secrets are scrubbed before the model-run child inherits its
  environment, the bundled ripgrep directory and irreducible Windows PATH entries are present,
  and the existing dev-toolchain discovery extends that repaired environment instead of
  rebuilding a subtly different one.

## [1.9.7] — 2026-08-23

1.9.6 was tagged but never published: its CI run failed and the release job failed with it, so
nothing in that section has reached anyone yet. It ships here, together with the fixes below.

### Fixed
- **A real failure could be recorded as a search that found nothing.** 1.9.6 exempted exit 1 from
  `rg`, `grep` and `findstr`, and decided which program set it by walking the pipeline from the
  right and skipping anything that looked like a PowerShell cmdlet. "Looked like" was any bare
  `verb-noun` token, and external executables are hyphenated too — so in `rg foo | docker-compose
  up`, the real failing stage was skipped, ripgrep was named as the status-determining program,
  and a build failure was stored as a result. Name shape cannot prove what a token is, so the
  inference is gone: an exact list of known cmdlets and aliases is treated as non-native and
  everything else is assumed to be a program. Not knowing a real cmdlet now costs an exemption,
  which is the safe direction to be wrong in.
- **A command the shell refused to run could be recorded as a search that found nothing.** The
  same exemption looked only at whether the output began with `rg:` or `grep:`. Windows
  PowerShell 5.1 answers `Write-Output hi && rg foo` with a parser error and exit 1 — nothing ran
  at all — and that was stored as a successful empty search. Shell and parser failures, missing
  commands and binding errors can no longer take the benign-exit path, whatever program the line
  would have ended in.

### Added
- **`{a,b}` brace groups are expanded the way bash would have expanded them.** PowerShell has no
  brace expansion, so `rg TODO src/{main,shared}` reached ripgrep with the braces intact and
  failed on a path that does not exist. The expansion is textual and needs no directory listing,
  so unlike glob expansion it applies to every statement of a command line rather than only the
  first. It is deliberately narrow: quoted tokens, flags, nested braces and anything holding a
  `|` or `;` are left exactly as written, and a script block `{ ... }` is never mistaken for one.
- **PowerShell 5.1 says what to write instead of `&&` and `||`.** These are not translated. `A;
  B` is not what `A && B` means — it runs B even when A failed, which can be a destructive
  follow-up that should have been gated — so the shell's own refusal is answered with the
  guarded forms instead: `A; if ($?) { B }` for `A && B`, and `A; if (-not $?) { B }` for
  `A || B`. The hint fires only on the parser error itself, so it stays silent on a shell where
  the operators work.
- **Two habits that fail without explaining themselves are stated up front.** The server
  instructions now say that `2>&1` on a native program leaves `$?` false even when the program
  exited 0, and give both chain-operator rewrites. Neither can be normalised away — stripping the
  redirect changes what the command returns — so they are said once rather than repaired after
  the fact.

### Internal
- Pending-call accounting now spans the whole MCP request rather than only the handler body.
  Calls waiting for late durable attribution remain observable in a dedicated recorder-settling
  count after their result is released, while the compaction machine barrier consumes only the
  still-dispatching count. This preserves the evidence needed to debug attribution gaps without
  coupling a browser handoff deadline to `REQUEST_ID_GRACE_MS`.
- The MCP shutdown test synchronises inside the PowerShell process it already started, instead of
  spawning a second `node` to write the file it waits for. 1.9.6 reintroduced that cold spawn and
  raised the wait to 15 seconds; on a hosted Windows runner the spawn outran the whole budget and
  failed the release. The early diagnostic that reports what the server actually answered is back
  with it, so a request that finishes before the command starts says so instead of timing out.
- The real-console test drives `cmd.exe` instead of a cold `powershell.exe`. The subject is
  ConPTY, not any one shell, and on a hosted runner PowerShell took longer to produce its first
  byte than the whole wait allowed — while the console tests either side of it passed in about a
  second. `mode con` asks the console for its own size, which a pipe cannot answer at all, so the
  proof is unchanged and the cold start is gone. `mode con` translates its labels, so the
  assertions read the number the console reported rather than the English word in front of it.
- The three window-state tests find a window before asking for its state, the way the window
  tests beside them already do. A hosted runner can have no visible desktop window at all, and
  `WINDOW_NOT_FOUND` is the correct production answer to that — asserting the runner has a
  desktop was the test's mistake, not the helper's.

## [1.9.6] — 2026-08-23

### Fixed
- **A compaction turn is no longer declared finished while it is still working.** The end of a
  turn was decided by one signal — the stop control staying gone for four seconds — and a long
  agentic turn makes that control flicker between phases. On 2026-08-23 that closed a compaction
  turn 28 characters into its brief, stored `TASK\nContinue implementing ` as the whole handoff
  for a session holding 455 events and 318,422 tokens, and opened the replacement chat with it
  while the original went on making tool calls for another seven minutes. The brief is now held
  until four things agree and keep agreeing: the stop control is gone, the answer has stopped
  growing, the turn's tool rail has stopped moving, and the app reports no local call still
  running. An app that cannot be asked counts as busy rather than as idle.
- **A brief too short to have carried the session is refused instead of stored.** Nothing
  downstream can tell a truncated handoff from a complete one, so the check happens before it is
  written. A refused compaction leaves the session exactly where it was and says why.
- **A resume no longer races the recorder for its own replacement chat.** The recorder invents a
  session for any conversation it has not seen; the commit moves the existing session onto that
  same chat. The recorder won by 302 ms, the commit found its destination already owned and
  refused to rebind, and the session stayed behind while the swarm's prime role moved on without
  it. New chats now wait, briefly and boundedly, while a replacement chat is expected — including
  after a restart that recovered a continuation still holding its claim.
- **`rg pattern *_test.go` works on PowerShell without silently widening.** PowerShell does not
  expand globs for native programs, so the pattern reached ripgrep literally and the call failed.
  The glob is now expanded against the working directory the way the shell would have, rather
  than rewritten to `-g`, which is a recursive filter that would also have matched
  `sub/nested_test.go`. Only the first statement of a command line is touched, because anything
  after it may have changed the directory or the files in it.
- **A search that found nothing is no longer recorded as a failed tool call.** `rg`, `grep` and
  `findstr` spend exit 1 on "no matches" and reserve other codes for real errors. The exemption
  applies only when the program that set `$LASTEXITCODE` — the rightmost native stage of the
  pipeline, not its generator — is one of those, and only when it printed no error of its own.
- **`read` accepts several paths and a line range in one call**, and says outright when a file
  has no lines in that range, so a short file can never read as a complete one.
- **A child process inherits the environment it was given**, and `JAVA_HOME` / `GOROOT` are
  filled in from an installed toolchain when — and only when — the tool would otherwise be
  unreachable. Versioned install directories are now compared as version numbers, so `jdk-21`
  outranks `jdk-9`.
- **git run outside a repository says so**, and names how to find the root, instead of returning
  a bare failure.

## [1.9.5] — 2026-08-23

### Added
- **The extension requirement is explicit where sub-agents are configured.** Setup now says
  worker chats require the companion extension to be loaded and connected, Chat settings repeats
  that requirement, and Setup includes a direct download link for the standalone extension ZIP.

### Fixed
- **Sub-agents can be enabled without restarting Chat On Steroids.** Swarm persistence hooks are
  now wired for the lifetime of the main process instead of only when multi-agent was enabled at
  startup, so the first `spawn` after enabling the feature can cross its durable acceptance
  barrier normally.

## [1.9.4] — 2026-08-22

### Added
- **Native Windows x64 and ARM64 release packaging.** Release candidates build and smoke-test
  each architecture on a matching Windows runner, bundle the matching tunnel/search assets and
  Chrome extension, and assemble explicit installers plus an extension zip and SHA-256 manifest.

### Changed
- **Fresh installs start fully enabled.** All file, command and desktop permissions begin on,
  read-only mode begins off, and multi-agent starts enabled with the existing two-worker
  default. Existing configs keep their explicit choices, and a corrupt config still recovers
  conservatively rather than treating damage as permission consent.
- **The Home activity log starts shorter**, leaving more vertical room for permissions,
  folders and health without changing the activity view itself.
- **Public setup and security guidance was refreshed for release.** The landing page now calls
  out the separate x64/ARM64 installers, bundled-extension install path, unsigned SmartScreen
  warning, current ChatGPT MCP access limits, and the experimental browser-automation terms risk.

### Fixed
- **Compact & Resume and browser-command recovery are durable across failures and restarts.**
  Continuation transitions now persist before publication, queued/leased browser commands and
  final receipts survive restart, and a committed resume cannot be cancelled by a late timeout
  or lost HTTP response.
- **Multi-agent finish and recovery paths are deterministic.** Terminal worker retries can
  recover their final result without reviving the worker, critical broker state has an awaited
  durability barrier, and resume transfers repair only from durable recovery evidence.
- **The extension no longer drops recoverable work on transient/protocol failures.** 426 keeps
  the observation journal for retry, command acknowledgements use a storage-backed outbox, and
  retry alarms are kept stable until durable work drains.
- **Browser/Fiber attribution is stricter under navigation and reused UI state.** Scan identity,
  request ownership and chronology stay fail-closed when ChatGPT reuses rows, ids or documents.
- **Session/catalog races no longer resurrect stale ownership.** Conversation attachment lookup,
  first-sight initialization and asset accounting now preserve the durable session as authority.

### Performance
- Reduced repeated filesystem scans and metadata calls in `read`, glob expansion and fallback
  search; reused already-read bytes for binary/encoding detection and reduced ripgrep buffer
  copying.
- Removed repeated browser journal/chronology scans and batched request-correlation persistence;
  streaming session messages now compare their fixed stored-text shape without repeatedly
  serializing large prose.

## [1.9.3] — 2026-08-21

### Changed
- **The app is now called Chat On Steroids.** The installer, the window, the connector
  names and the extension all use the new name. Two consequences on upgrade: the new
  build installs alongside the old one rather than over it, and settings live in a new
  folder (`%APPDATA%\chat-on-steroids\`), so the stored API key and recorded sessions
  do not carry across. **Reload the extension** — the bridge handshake changed with the
  name, and an old extension is refused with a visible error rather than failing quietly.
- **`spawn` takes a shared `context`.** The repository, the conventions file, what not to
  touch, how to validate, what to report — written once for the batch, and put in front
  of every worker's own task. Each `task` now carries only that worker's objective.
- **`message` sends a batch.** `action='message'` accepts a `messages` array as well as a
  single `to`/`text`: three redirected workers are one tool call instead of three, and
  the batch is delivered in full or not at all.
- **Every `agents` reply carries machine-readable state** beside its sentence of prose —
  the run, the caller, each agent and anything queued — so the model reads state rather
  than parsing English.
- **Workers are asked for a structured handoff**: RESULT, CHANGES, VALIDATION, BLOCKERS.
- **The preamble typed into a worker's chat is three lines shorter**, saying only who it
  is and how to report.
- **A closed tab no longer ends a worker.** A ChatGPT turn runs on OpenAI's servers, so
  closing the tab loses this app's view of the worker rather than stopping it. Such a
  worker shows as *no tab*, keeps its slot, and rejoins the moment it calls again; it is
  given up on only once it has also gone quiet.

### Removed
- **`agents(action='join')` and its recovery key, entirely.** It was the last credential
  in the app and the only field a model could present as identity. A worker is the chat
  the app opened for it; a binding that goes missing is restored by the extension
  reporting the chat, not by pasting a key. The desktop window's recovery-key button is
  gone with it.

## [1.9.2] — 2026-08-21

Pre-public beta milestone.

### Fixed
- Harvest the request id before ChatGPT's safety check releases it. The id used to
  correlate a tool call with the turn that caused it could be gone by the time it
  was read, which surfaced as calls landing under the wrong turn or under
  *Unattributed activity*.

## [1.9.1] — 2026-08-21

### Fixed
- Attribute MCP calls that arrive without a `data-turn-id`. ChatGPT does not always
  stamp the attribute; those calls previously fell through to *Unattributed*.

## [1.9.0] — 2026-08-21

### Fixed
- Live transcript ownership and chronology. Turn identity could leak from an older
  generation into a newer one, progress ids could be reused across generations, and
  the same semantic tool row could be recorded two or three times under
  index-derived ids. Identity is now scoped per generation rather than trusting a
  DOM attribute that survives React node reuse.

## [1.8.9] — 2026-08-21

### Changed
- Hardening pass across MCP lifecycle, path handling and process control.
- The test suite terminates reliably instead of leaving stray workers behind.

## [1.8.4] — 2026-08-20

### Added
- Refreshed application icon.
- Current Codex-derived base tools ported to Core.

### Fixed
- Turn-killer bug; session identity now survives a reload.
- Live transcript capture and attribution repair.

## [1.7.6] — 2026-08-18

### Changed
- Reduced model-facing tool surface from 45 tools / ~60 kB to 12.5 kB across six
  core tools and 7.9 kB across two desktop tools, with those sizes held as test
  budgets. See [`docs/tool-surface.md`](docs/tool-surface.md).

## [1.5.1] — 2026-08-15

### Changed
- Hardened MCP workflows and process control.
- Corrected the documented Electron user-data path.

## [1.5.0] — 2026-08-15

### Added
- Transactional batch edits and process output cursors.

[1.9.5]: https://github.com/totec448-spec/chat-on-steroids/releases/tag/v1.9.5
[1.9.4]: https://github.com/totec448-spec/chat-on-steroids/releases/tag/v1.9.4
