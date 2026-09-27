<p align="center">
  <img src="https://github.com/user-attachments/assets/257a650d-d31c-42dd-80e4-2a622e518970" width="960" alt="Eve coordinating six AI workers around plans, tasks and results" />
</p>

<h1 align="center">ParadigmEve</h1>

<p align="center"><strong>A durable AI workspace around ChatGPT.</strong><br />
Eve can work with your files and terminal, coordinate reusable workers, keep Plans and Pins across chats, and carry useful context forward instead of starting from zero every time.</p>

<p align="center">
  <a href="https://github.com/absol89/ParadigmEve/releases"><strong>Download / Releases</strong></a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
  &nbsp;·&nbsp;
  <a href="docs/setup.md">Setup</a>
  &nbsp;·&nbsp;
  <a href="docs/product/README.md">Product direction</a>
</p>

> **Beta software.** ParadigmEve is actively self-tested and changes quickly. The current public line is **2.2.5**. Windows x64 debug builds are the primary qualification target right now.

## What Eve is for

ParadigmEve is an Electron workspace plus a ChatGPT Companion extension. ChatGPT still owns the model and conversation; Eve adds a durable local layer around it.

- **Work on the real machine.** Read and edit approved files, run commands and tests, keep terminals alive, and use Computer Use when you explicitly enable it.
- **Delegate without losing the thread.** Eve can send bounded jobs to reusable worker chats, receive their results, and keep the owning conversation in charge.
- **Keep durable context.** Pins, Threads, Hotlinks, Concepts, Plans, Schedules and the local Archive survive browser churn and long conversations.
- **Continue across chats.** Compact & Resume and restart recovery preserve local session history while ChatGPT conversations remain replaceable frontends.
- **Stay inspectable.** Tool calls, Plans, worker activity and local evidence remain visible instead of being hidden behind a single opaque assistant response.

## Plans that stay attached to the work

Plans are durable checklists with source links and visible progress. Eve can keep a plan alive while work moves through browser turns, workers and restarts, then leave the final archive/sign-off decision to you.

<p align="center">
  <img src="https://github.com/user-attachments/assets/988a1b0d-1fd4-4aaf-8049-76b3df5144ad" width="900" alt="ParadigmEve Plans view showing a completed autonomy test with linked source and archive action" />
</p>

## Pins, Threads, Hotlinks and Concepts

ParadigmEve has a small shorthand for context you want to reuse:

- **`%Thread`** — durable context with saved message Pins and an optional prompt.
- **`%Hotlink`** — prompt/action-oriented shortcut with no Pins yet.
- **`#Concept`** — passive context with no prompt, useful when you want Eve to draw from an idea without automatically running an instruction.
- **`#Quilt`** — a wider grouping that can connect related Threads without turning them into one giant prompt.

<p align="center">
  <img src="https://github.com/user-attachments/assets/3fb505b2-f2b6-41d8-b3e2-c289dde3e01f" width="900" alt="ParadigmEve Pins view showing Hotlinks, Threads, Concepts and Quilts" />
</p>

That makes short prompts such as `help me %organize yesterday's notes about our #schedules` useful without turning the app into a giant clipboard or a second chat history.

## Schedule work around real life

Schedules let you keep Eve routines and your own availability in the same place. The app can surface when both sides are actually available without inventing calendar information it does not know.

<p align="center">
  <img src="https://github.com/user-attachments/assets/4f6b106f-dd4a-4621-bf9f-614a808f5bc2" width="960" alt="ParadigmEve Schedule view with personal availability and Eve routines" />
</p>

## Local archive and recovery

ParadigmEve records durable local conversation evidence and can build a static recovery browser from it. The archive is designed to survive a deleted or unavailable ChatGPT conversation without pretending that locally missing content was captured.

<p align="center">
  <img src="https://github.com/user-attachments/assets/c0efef3c-5497-448f-8a03-edeb82540684" width="900" alt="ParadigmEve local Archive and recovery view" />
</p>

## Get started

1. Download the current build from **[Releases](https://github.com/absol89/ParadigmEve/releases)**.
2. Open **Settings → Setup** and follow the onboarding flow.
3. Approve only the folders and capabilities you want Eve to use.
4. Load/pair the ParadigmEve Companion in the dedicated Chromium profile when setup asks you to.
5. Connect ParadigmEve in ChatGPT, start an Eve chat, and give it a real task.

The current Windows build is unsigned beta software, so Windows may show a SmartScreen warning. Verify release hashes when they are provided and review permissions before enabling filesystem, terminal or Computer Use access.

### Requirements

- A ChatGPT account with access to the connector / Developer-mode features ParadigmEve uses.
- A current Chromium browser for the Companion workflow.
- Windows 10/11 for the primary self-tested build. The source tree also contains macOS and Linux packaging paths, but they are not the current installed-runtime qualification target.

## How the pieces fit together

```text
ChatGPT model
    │
    │  ParadigmEve connector / MCP
    ▼
ParadigmEve local app ─── files / terminal / desktop / durable state
    ▲
    │  exact browser evidence, conversation state, delivery
    │
Companion extension in the dedicated ChatGPT browser profile
```

The important boundary is intentional: the browser owns browser state; the ParadigmEve app owns local machine access. Exact conversation identity is required where a wrong guess could mutate or attribute work to the wrong chat.

## Safety and control

ParadigmEve is powerful because it can act on your machine. Treat that access like any other local automation tool:

- approve narrow workspace roots;
- review Computer Use and clipboard permissions before enabling them;
- keep sensitive chats/projects separate when appropriate;
- inspect Plans and tool results rather than assuming an AI-reported success means the local action happened;
- use a dedicated browser profile for Eve.

See **[SECURITY.md](SECURITY.md)** and the **[engineering vault](docs/vault/README.md)** for the deeper trust and recovery model.

## Project status

ParadigmEve is a personal/open development project built through continuous self-testing. The public releases intentionally expose work in progress rather than presenting every feature as settled product behavior.

Useful links:

- [Latest releases](https://github.com/absol89/ParadigmEve/releases)
- [Changelog](CHANGELOG.md)
- [Setup and help](docs/setup.md)
- [Product docs](docs/product/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT license](LICENSE)

## Credits

ParadigmEve grew from the open-source **[Chat-on-Steroids](https://github.com/totec448-spec/chat-on-steroids)** codebase and continues to learn from its contributors' browser-integration, recovery and ChatGPT compatibility work. Thank you to the Chat-on-Steroids contributors and to everyone testing the rough edges of agentic workflows in public.

<p align="center"><sub>ParadigmEve is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.</sub></p>
