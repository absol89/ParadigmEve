<p align="center">
  <img src="https://github.com/user-attachments/assets/257a650d-d31c-42dd-80e4-2a622e518970" width="960" alt="Eve and her helpers working together" />
</p>

<h1 align="center">ParadigmEve</h1>

<p align="center"><strong>Make ChatGPT useful for work beyond a single chat.</strong><br />
Eve connects a ChatGPT conversation to real files, local tools, durable Plans, and ongoing work on your computer—so projects survive interruptions and the assistant can help finish them.</p>

<p align="center">
  <a href="https://github.com/absol89/ParadigmEve/releases"><strong>Downloads</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/release-notes/v2.4.5.md">2.4.5 release notes</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
  &nbsp;·&nbsp;
  <a href="docs/setup.md">Setup guide</a>
</p>

> **Open-source beta.** Download only packages actually listed on [GitHub Releases](https://github.com/absol89/ParadigmEve/releases). Source branches, Git tags, installed test builds, and published installers are not interchangeable. Packages may be unsigned.

## Why Eve instead of only chatgpt.com?

ChatGPT already offers memory, projects, apps, and other useful features. ParadigmEve adds **a desktop execution and continuity layer** for people whose work lives outside the conversation.

| Your work | What Eve adds |
| --- | --- |
| Editing a real project | Permission-scoped local files, patches, commands, builds, and test results in the same workflow. |
| Working past one chat | Durable local sessions and Plans, reusable helper chats, recovery after restart, and **Compact & Resume** handoffs. |
| Repeating work | Locally backed schedules, routines, saved context, and reviewable progress instead of relying on a chat reply as proof. |
| Doing work on your own hardware | Local file operations, tests, and supported audio processing can run on your computer rather than invoking a separately billed cloud model for every operation. |
| Using desktop software | Optional, separately permissioned screen, control, and clipboard tools, plus a broker for inspecting office formats and discovering available editors. |

**What “unmetered local work” means:** reading files, running a local test, or doing local processing does not *itself* consume a separately metered OpenAI API inference call. Asking ChatGPT to plan, invoke tools, analyze results, or continue a conversation **still uses your actual ChatGPT account access and limits**. API-based services may charge separately, and local models consume your own hardware resources. Eve does not unlock unlimited ChatGPT messages, reasoning, context windows, models, or rate-limit exemptions.

### Does it feel more reliable?

In our hands-on use, **GPT-5.6 Sol Medium and GPT-6 High workflows have seemed more reliable through Eve than the basic ChatGPT Plus browser experience**. This is a subjective, end-to-end observation, **not** a controlled model benchmark. The likely advantage is Eve's recoverable work state, exact tool evidence, Plans, workers, and handoffs—not a claim that Eve makes the underlying models smarter or increases their quotas. Available models and reasoning levels remain controlled by your ChatGPT account and your own model-picker choice.

## What can you do with it?

- **Finish software and file work:** inspect and edit approved project files, run terminal commands and tests, coordinate steps through Plans, and audit the actual results.
- **Keep complicated tasks moving:** delegate separate pieces to reusable helper chats, preserve the main Eve conversation as coordinator, and pick up after a restart or a long-chat handoff.
- **Choose how helpers work:** **ChatGPT workers** keep individually reviewable helper chats; **Native subagents** work inside an active ChatGPT Work conversation and return to its parent without a separate Eve worker chat; **OpenRouter** and **Ollama** use an explicitly configured provider/model. Native subagents have not yet been proven as an unattended Eve worker/heartbeat executor, so Eve must hold such work for a verified parent instead of silently switching modes or claiming it finished.
- **Notice when ChatGPT itself needs you:** the 2.4.5 Companion can detect a current-turn tool approval card even when ChatGPT has collapsed it under **Previous activity**, record the wait, and surface a native notification. Eve does not click or auto-approve the provider card, and disappearance alone is not proof of approval.
- **Remember useful context on purpose:** save Pins in Threads, create reusable prompts in the `%instructions` category (invoke an individual one by its exact `%name`), group Threads into Quilts (`#name`), and review locally recorded conversation evidence.
- **Run local and scheduled workflows:** set up routines, use a bounded read-only heartbeat to review recorded requests and Plans, and optionally enable Goal/Loop continuation. The heartbeat reviews; it does **not** autonomously execute discoveries.
- **Transcribe and work with documents:** supported Windows x64 builds can use local Whisper transcription and speaker diarization, with optional explicitly selected cloud speech recognition. DOCX, XLSX, PDF, and PPTX inspection uses the built-in file broker; editing depends on an available provider and consent. WordCraft and GridCraft are separate developing apps, not bundled full-fidelity editors.
- **Help across desktop apps:** explicitly enable Computer use for screen inspection, mouse/keyboard interaction, or clipboard access when needed.

None of these capabilities require you to enable *every* permission.

## Get started

1. Choose an available package on [GitHub Releases](https://github.com/absol89/ParadigmEve/releases) and open ParadigmEve.
2. In **Settings → Workspace → Folders → Add**, approve a folder for Eve to work in; review **Permissions**, especially **Run commands**.
3. In **Settings → Setup**, configure the connection and add/pair the browser Companion as guided.
4. At [chatgpt.com/plugins](https://chatgpt.com/plugins), choose **Add → Add custom MCP server** and connect Eve; review its ChatGPT action permissions. Your account must support custom MCP apps.
5. Give Eve a concrete job. Select your preferred model when offered; Eve must not silently switch it.

See the [setup reference](docs/setup.md) for detailed connection and platform instructions, or [2.4.5 notes](docs/release-notes/v2.4.5.md) for the latest source and acceptance limitations.

## Privacy, permissions, and limits

**Local chat recording is on by default** to support continuity, review, and auditability. You can turn it off in **Workspace → Permissions** or beside **Rebuild archive** and **Open Archive Browser**; Setup and Settings also point to this control. With recording off, Eve stops storing **new** local session messages and tool history, and recording-dependent features such as Goal/Loop are unavailable. It **does not erase** earlier sessions, archive copies, Pins, Plans, app logs, separate outputs, or ChatGPT's own history. Local storage is not a blanket privacy guarantee; review what you save. [Archive and retention details](docs/vault/08-persistence-security-and-filesystem.md).

Files require approved folders, and Computer use is opt-in. **Run commands is enabled by default** but executes under your operating-system user account, **not** inside a sandbox restricted to approved folders. Disable it in Workspace permissions until needed if you want a narrower starting point. Protect important files with backups and read tool receipts instead of trusting an assistant's assertion alone. [Security details](SECURITY.md).

ParadigmEve requires an eligible ChatGPT account and Chrome/Chromium, Edge, or Brave for its Companion workflow. Supported desktop targets include Windows 10/11, macOS 13+, and current Linux; Windows x64 has the most live installed test coverage. Other platforms, cloud providers, GPU availability, editing tools, and account features vary.

## Release status

**2.4.5 source (October 28, 2026):** Windows x64 c26 passed 6,232 local tests and was silently installed with a matching packaged/installed application hash. Cumulative fixes protect active Compact & Resume turns, worker ownership, archive continuity and Native heartbeat transport. One Native in-band heartbeat was completed after four exact Plan acknowledgements and a durable receipt without another browser Send; a later review was truthfully blocked on unresolved historical worker evidence. Manual hosted-child review succeeded, but idle background cognition, automatic app-owned child dispatch and repeated mode-switch queue retirement are not yet proven. c26 still embeds Electron 43.8.3 / Node 24.22.0; the security update to Electron 43.8.4 / Node 24.22.1 needs a separately verified candidate. ChatGPT tool approvals remain user-controlled. See [2.4.5 release notes](docs/release-notes/v2.4.5.md) for evidence and limits. A source tag or branch push does not publish installers or promote Latest; consult [GitHub Releases](https://github.com/absol89/ParadigmEve/releases) for downloads.

## Build and contribute

Start with [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), and the [engineering vault](docs/vault/README.md).

```sh
npm ci
npm run dev
npm run verify
```

ParadigmEve builds on the open-source [Chat-on-Steroids](https://github.com/totec448-spec/chat-on-steroids) project. Thanks to the contributors and testers who uncover difficult continuity and recovery cases.

**[Downloads](https://github.com/absol89/ParadigmEve/releases)** · **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)** · **[MIT License](LICENSE)**

<p align="center"><sub>ParadigmEve is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.</sub></p>
