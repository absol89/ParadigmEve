<p align="center">
  <img src="https://github.com/user-attachments/assets/257a650d-d31c-42dd-80e4-2a622e518970" width="960" alt="Eve and her helpers working together" />
</p>

<h1 align="center">ParadigmEve</h1>

<p align="center"><strong>Bring Eve the mess. Leave with less to do.</strong><br />
Give ChatGPT a place to help with the practical work on your computer: the folders you choose, unfinished projects, Plans, saved context, and tasks that need more than one chat.</p>

<p align="center">
  <a href="https://github.com/absol89/ParadigmEve/releases"><strong>Download ParadigmEve</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/release-notes/v2.4.0.md">2.4.0 status &amp; release notes</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
  &nbsp;·&nbsp;
  <a href="docs/setup.md">Setup reference</a>
</p>

> **Beta software.** Get an actual published download from the [Releases page](https://github.com/absol89/ParadigmEve/releases). A source version/tag, a locally installed development candidate, and a downloadable installer are three different things. Builds are not publisher-signed, so Windows or macOS may warn during installation.

## Meet Eve

ParadigmEve is a desktop home for an Eve conversation in ChatGPT.

You still talk to ChatGPT normally. ParadigmEve adds the practical things that are hard to keep attached to one browser chat: your chosen project folder, local tools, Plans, helper chats, saved context, a local archive, and the ability to continue after a restart or a very long conversation.

The idea is simple: **you keep one conversation in charge, and Eve gets better at actually finishing the work around it.**

ParadigmEve is free and open source, but it is **not** an unlimited free ChatGPT subscription. You need a ChatGPT account with access to the required MCP app features for the ChatGPT workflow. Other providers may have separate charges; local models need suitable hardware. Setup includes a browser Companion, a connection to Eve, and permissions you explicitly choose. Eve does not unlock account features or bypass rate limits.

Eve can:

- read and change files inside folders you approve;
- run commands and tests on your computer;
- keep a Plan attached while work moves across many ChatGPT turns;
- ask reusable helper chats to work on separate parts of a bigger job;
- transcribe recordings and separate speakers locally when the packaged engine and needed models are available;
- save useful messages and context for later;
- recover the same local session after a restart;
- move a long session into a fresh ChatGPT chat with **Compact & Resume**;
- look at and control desktop apps when you explicitly turn on Computer use.

You do **not** have to enable all of that to use Eve.

## Work with Word documents, spreadsheets, PDFs and slides

Ask Eve to open, proofread, edit or show you work on a DOCX, XLSX, PDF or PPTX file in an ordinary **fresh chat**. ParadigmEve exposes a built-in file broker through Eve's Core tools and standing guidance, so you do not need to activate `%how` or explain its tools. Eve should check the broker **before** suggesting a generic office-suite install. Built-in readers can inspect these formats without installing another editor.

If the file is in a folder you approved, `file_action` can inspect the actual file and discover suitable editing providers. If you only have a **ChatGPT Library link**, Eve can still ask `file_action` which provider handles a known extension, such as `docx`, but that lookup does **not** open or download the Library file. Actual editing requires an accessible local copy in an approved folder (for example, a native attachment saved there when available). A Library URL alone is not a local file path.

For Word documents, the broker can offer **WordCraft** (`artcraft.wordcraft`); for spreadsheets, **GridCraft** (`artcraft.gridcraft`). These are separate in-development apps, **not** preinstalled office suites or guarantees of complete DOCX/XLSX fidelity. With a compatible available provider, `file_edit` can discover its tools, edit a **new copy**, or open that copy visibly when the desktop app and permissions allow it. Installation requires your agreement and confirmation in ParadigmEve's native dialog; detected feature loss requires separate approval. The original file remains untouched by broker-managed edits. The 2.4.0 source—including c28's build baseline—teaches Eve to discover the broker in fresh chats; that does not guarantee any particular provider is available, installed, or able to edit a given document.

See the [file-broker workflow in the engineering manual](docs/vault/03-mcp-connectors-and-tools.md#file-broker-inspect-offer-edit-or-show) for the exact operations.

## The easiest way to start

1. Download **[ParadigmEve](https://github.com/absol89/ParadigmEve/releases)** for your computer.
2. Open **Settings → Workspace → Folders → Add** and give Eve one folder you are comfortable using.
3. Open **Settings → Setup** and follow the guided connection steps.
4. Add the included Companion extension when Setup asks you to.
5. Go to **[chatgpt.com/plugins](https://chatgpt.com/plugins)**, press the **Add** button at the top right, choose **Add custom MCP server**, and add Eve. After saving it, open **ChatGPT → Settings → Plugins → Eve → Permissions** and start with **Allow low risk actions**.
6. Give Eve a real job.

For this source line's current features, caveats and upgrade status, read the **[2.4.0 release notes](docs/release-notes/v2.4.0.md)**. The [setup reference](docs/setup.md) has connection and troubleshooting details; the [2.3.8 first-use guide](docs/release-notes/v2.3.8.md) remains a historical walkthrough.

## Safe first, then convenient

A fresh install does not automatically get access to your files or desktop.

- No folders are approved until you add them.
- Computer use starts off: screen, mouse/keyboard, and clipboard access are separate choices.
- Eve cannot change ParadigmEve settings, archive completed Eve work, or control the ParadigmEve window until you allow it.
- Automatic startup and automatic connection start off.
- Goal and Loop do not start running by themselves.
- The normal Core permissions, including file changes and **Run commands**, start available. File tools still have no folder to touch until you approve one.

Ordinary Eve tools and two helper slots are ready, but file access still has to pass the folder, permission, and exact-chat checks before it can touch your files.

One important exception: **Run commands** is shell access, and its permission starts on. A command still needs an approved workspace as its starting point, but once it runs it uses your normal computer user and is not confined to approved folders. If you want the strictest first-time setup, turn **Run commands** off under **Settings → Workspace → Permissions** until you need it.

One convenience is already enabled: **Allow Eve in other ChatGPT chats and devices**. If you want Eve to answer only from the main Eve browser chat, turn that off under **Settings → Setup → Advanced → Eve authority**.

## A smooth everyday setup

Once the basic connection works, a practical optional setup is to:

- approve the few folders Eve genuinely needs;
- turn on Computer use if you want help across desktop apps;
- turn on **Start ParadigmEve when I sign in** and **Connect automatically at startup**;
- under **Eve authority**, allow the things you want Eve to maintain for herself;
- let Eve use a few workers for bigger jobs instead of doing every step serially.

Two worker slots are the fresh-install default; you can raise that for larger tasks if your ChatGPT account has capacity.

The exact switches, paths, and permissions are explained in the **[setup reference](docs/setup.md)** and [2.4.0 notes](docs/release-notes/v2.4.0.md). Older [2.3.8](docs/release-notes/v2.3.8.md) and [2.3.9](docs/release-notes/v2.3.9.md) notes document previous releases, not the latest source behavior.

## Plans stay with the work

Plans are durable checklists that Eve can keep attached to work across chats, helpers, restarts, and long sessions.

<p align="center">
  <img src="https://github.com/user-attachments/assets/988a1b0d-1fd4-4aaf-8049-76b3df5144ad" width="900" alt="ParadigmEve Plans view" />
</p>

The **Plans** tab keeps your commitments and Plans created in the main Eve/Prime chat. **Eve activity** shows execution Plans whose recorded source belongs to a worker or helper chat, including completed work in **Done** after archiving. An Eve-written Plan does **not** move into Eve activity just because Eve wrote it: the originating session decides. Steps can be completed without archiving the whole Plan; you can inspect its source and decide when it belongs in Done. Workers report to Prime, but a report/handoff is not a separate checklist step.

## Save the things you want to reuse

ParadigmEve gives saved context a few simple shapes:

- **`%Thread`** — a specific stream of saved context you want to keep using.
- **`%Instruction`** — a saved prompt or shortcut you can invoke again.
- **`#Concept`** — passive context around an idea, without an instruction that automatically runs.
- **`#Quilt`** — a wider grouping for related Threads.

<p align="center">
  <img src="https://github.com/user-attachments/assets/3fb505b2-f2b6-41d8-b3e2-c289dde3e01f" width="900" alt="ParadigmEve Pins, Threads, Instructions, Concepts and Quilts" />
</p>

You do not need to learn these on day one. They are there when you notice yourself saying, “I wish Eve remembered this particular thing next time.”

## Helpers for the jobs that take a while

Eve can open helper chats for separate pieces of a larger job — for example one helper checking tests while another reads documentation.

The helpers report back to Eve. They are not separate owners of your project, and they cannot start their own swarms of helpers.

This matters most on the jobs where a single ChatGPT conversation would otherwise go quiet for several minutes doing everything one step at a time.

## Transcribe recordings and separate speakers

On supported Windows x64 builds, use **Attach → Transcribe recording…** to work with an audio file. Local Whisper speech recognition and local speaker diarization can produce speaker-labelled text; the first run may need to download verified speech, speaker and audio-tool components. Speakers and overlapping speech are not always identified correctly, so review important transcripts.

**Settings → Transcription** lets you prioritize CPU/local speech recognition, a GPU route when its actual Vulkan compute probe passes, or explicitly selected Groq/OpenAI cloud speech recognition. The speaker separation remains local. Cloud transcription sends audio to the selected provider; purely local processing does not. An installed GPU-capable engine and a usable driver are both required—having a GPU does not mean every installer includes that engine. See the [2.4.0 transcription details](docs/release-notes/v2.4.0.md#new-settings--transcription).

## A review heartbeat, not an autopilot

About every 22 minutes, an app-owned **read/review-only worker** can check locally recorded requests and a small batch of Live Plans for unfinished, still-relevant work. It uses the exact source and newer instructions, not ChatGPT browser-history browsing. The worker records classifications and can return findings to Prime; **Prime remains responsible for doing the work**, and a browser send receipt or a reassuring chat reply does not count as a completed review. If identity or evidence is missing, the review stays pending rather than guessing.

## Keep going when a chat gets too long

ParadigmEve keeps a local session around the ChatGPT conversation.

When a conversation gets too large, **Compact & Resume** can create a handoff, open a fresh ChatGPT conversation, and keep the same local project, Plan, worker history, and recorded context attached.

If the app or browser restarts, ParadigmEve uses that local session to reconnect to the work instead of treating every restart like a brand-new project.

## Your local archive

ParadigmEve records the conversation evidence it actually sees and can build a local static archive from it.

<p align="center">
  <img src="https://github.com/user-attachments/assets/c0efef3c-5497-448f-8a03-edeb82540684" width="900" alt="ParadigmEve local Archive view" />
</p>

The archive is deliberately honest: if ParadigmEve never captured something, it does not pretend it did.

## Schedules and routines

You can also keep Eve routines and your own availability together in the Schedule view.

<p align="center">
  <img src="https://github.com/user-attachments/assets/4f6b106f-dd4a-4621-bf9f-614a808f5bc2" width="960" alt="ParadigmEve Schedule view" />
</p>

This is useful for recurring work where “when should Eve do this?” matters as much as the task itself.
If you create or change a reminder in conversation, Eve can keep the reason, relevant decisions and
observations, preferred format, and exact reusable context references with the schedule so a fresh
scheduled chat does not have to guess what the reminder originally meant.

## Desktop companions

Luna, Hammy, Miso the cat, and Pip the dog are bundled animated desktop pets. Choose which ones appear in **Settings → Pets**. You can drag them around your desktop and click a pet to return to Eve.

On a fresh install, Luna is enabled. Hammy, Miso, and Pip start disabled; Miso and Pip are already marked as favorites. Updates preserve your saved pet choices.

## 2.4.0: tagged source, installed candidate, published download

The app and Companion source currently declare **2.4.0**, and the public `v2.4.0` source tag points to commit `aac7643b`. That is a **source checkpoint**, not confirmation that every platform installer exists on GitHub Releases.

Separately, the **c28 Windows x64 development candidate** was installed and dogfooded locally. Reported successful checks include heartbeat, Compact & Resume, restart wake, transcription/diarization, a usable GPU compute probe, opening WordCraft/GridCraft, and controlled Force Send. Its recorded build includes source-aware microphone/system-audio processing and narrow-screen Pins improvements; those being packaged is **not** proof that automatic speaker discovery, overlapping speakers, or merged source-aware output passed live acceptance. Fresh-chat broker discovery also predates c28, although opening an editor does not prove end-to-end document fidelity. Later worker-Plan prompting changes in tagged source must not automatically be attributed to the installed candidate.

For a fresh install, use only the binaries actually listed under **[GitHub Releases](https://github.com/absol89/ParadigmEve/releases)** and verify the matching release notes and checksums. A local candidate directory, installed c28, Git tag, and CI build are not interchangeable evidence of a downloadable release. macOS, Linux and Windows ARM64 have not received equivalent live c28 acceptance. Read the [2.4.0 release notes](docs/release-notes/v2.4.0.md) for the detailed provenance.

## Requirements

- Windows 10/11, macOS 13 Ventura or newer, or a current desktop Linux.
- Chrome / Chromium, Edge, or Brave for the Companion workflow.
- A ChatGPT account/workspace that can add custom MCP servers from **chatgpt.com/plugins → Add → Add custom MCP server**.

Windows is the primary self-tested desktop at the moment, but the release workflow also builds the macOS and Linux packages listed on the release page.

## Safety

ParadigmEve can become a powerful local assistant, so its permissions should stay understandable.

- Give Eve the folders her file tools actually need rather than your whole computer.
- Remember that **Run commands** is broader than the folder boundary and runs with your normal user privileges.
- Turn on screen, control, and clipboard access only when you want those abilities.
- Keep backups of important work.
- Read Plans and real tool results instead of treating a confident sentence from an AI as proof that something happened.
- Use the dedicated browser profile / Companion setup so ParadigmEve can prove which chat is acting.

For the deeper details, see **[SECURITY.md](SECURITY.md)**. For setup troubleshooting and the less friendly reference material, see **[docs/setup.md](docs/setup.md)** and the **[engineering vault](docs/vault/README.md)**.

## Build and contribute

If you are here to work on ParadigmEve itself rather than just use it, start with **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[AGENTS.md](AGENTS.md)**.

Development basics:

```sh
npm ci
npm run dev
npm run verify
```

## Credits

ParadigmEve grew from the open-source **[Chat-on-Steroids](https://github.com/totec448-spec/chat-on-steroids)** codebase and still learns from its contributors' browser integration, recovery, and ChatGPT compatibility work.

Thanks to everyone testing the awkward edge cases, reporting what breaks, and helping make long-running AI work less fragile.

---

**[Download ParadigmEve](https://github.com/absol89/ParadigmEve/releases)** · **[2.4.0 status & release notes](docs/release-notes/v2.4.0.md)** · **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)** · **[MIT License](LICENSE)**

<p align="center"><sub>ParadigmEve is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.</sub></p>
