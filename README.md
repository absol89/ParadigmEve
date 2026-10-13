<p align="center">
  <img src="https://github.com/user-attachments/assets/257a650d-d31c-42dd-80e4-2a622e518970" width="960" alt="Eve and her helpers working together" />
</p>

<h1 align="center">ParadigmEve</h1>

<p align="center"><strong>Bring Eve the mess. Leave with less to do.</strong><br />
Give ChatGPT a place to help with the practical work on your computer: the folders you choose, unfinished projects, Plans, saved context, and tasks that need more than one chat.</p>

<p align="center">
  <a href="https://github.com/absol89/ParadigmEve/releases"><strong>Download ParadigmEve</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/release-notes/v2.3.9.md">2.3.9 guide &amp; release notes</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
  &nbsp;·&nbsp;
  <a href="docs/setup.md">Setup reference</a>
</p>

> **Beta software.** Get an actual published download from the releases page; a version mentioned in the source tree may still be a release candidate. The builds are not publisher-signed, so Windows or macOS may warn during installation.

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
- save useful messages and context for later;
- recover the same local session after a restart;
- move a long session into a fresh ChatGPT chat with **Compact & Resume**;
- look at and control desktop apps when you explicitly turn on Computer use.

You do **not** have to enable all of that to use Eve.

## The easiest way to start

1. Download **[ParadigmEve](https://github.com/absol89/ParadigmEve/releases)** for your computer.
2. Open **Settings → Workspace → Folders → Add** and give Eve one folder you are comfortable using.
3. Open **Settings → Setup** and follow the guided connection steps.
4. Add the included Companion extension when Setup asks you to.
5. Go to **[chatgpt.com/plugins](https://chatgpt.com/plugins)**, press the **Add** button at the top right, choose **Add custom MCP server**, and add Eve. After saving it, open **ChatGPT → Settings → Plugins → Eve → Permissions** and start with **Allow low risk actions**.
6. Give Eve a real job.

For current changes, permissions and upgrade notes, read the **[2.3.9 release notes and setup guidance](docs/release-notes/v2.3.9.md)**. The [2.3.8 guide](docs/release-notes/v2.3.8.md) has a fuller first-use walkthrough and screenshots for the same basic setup path.

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

Once the basic connection works, the setup I like is:

- approve the few folders Eve genuinely needs;
- turn on Computer use if you want help across desktop apps;
- turn on **Start ParadigmEve when I sign in** and **Connect automatically at startup**;
- under **Eve authority**, allow the things you want Eve to maintain for herself;
- let Eve use a few workers for bigger jobs instead of doing every step serially.

My own setup uses four worker slots. Two is the fresh-install default and is friendlier to accounts that hit ChatGPT rate limits quickly.

The exact switches, paths, and the more permissive options are explained in the **[2.3.8 first-user guide](docs/release-notes/v2.3.8.md)**; see [2.3.9 release notes](docs/release-notes/v2.3.9.md) for the latest reliability changes.

## Plans stay with the work

Plans are ordinary checklists that Eve can keep attached to a job while the work moves through chats, helpers, restarts, and long sessions.

<p align="center">
  <img src="https://github.com/user-attachments/assets/988a1b0d-1fd4-4aaf-8049-76b3df5144ad" width="900" alt="ParadigmEve Plans view" />
</p>

You can see what is done, what is still open, and where the Plan came from. Eve and workers can finish their own work, but your own Plans stay yours to archive.

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

## What's changing in 2.3.9

2.3.9 concentrates on **reliable conversation delivery and keeping Prime Eve's work together**:

- **Force send for stuck messages:** a new outbox action lets you explicitly re-offer an original message that was never claimed by the browser, even if a restart left stale turn activity behind. It uses the same message ID and cannot replay a claimed or ambiguous Send. The browser must still prove the correct chat, idle composer, draft and Voice safety.
- **Fresh-chat pickup recovery:** the Companion recognizes marked new chats entering a linked ChatGPT Project and allows a newly elected tab to finish its brief `about:blank` startup before offering the message. It does not gain permission to close normal conversation tabs.
- **Faster Compact & Resume binding:** first-answer stream observations now recognize the fresh-chat `resume_conversation_token` and nested delta identity fields, rather than assuming first turns contain `stream_handoff` and `input_message`. Conflicting identities still fail closed.
- **More reliable replies and model choices:** GPT-6 answer recovery, current-chat model display, and restart recovery retain the actual conversation's selected provider/model; a model change still requires your confirmation in the picker.
- **Clearer diagnostics and setup:** Activity's optional timing toggle and the custom ChatGPT app setup instructions are localized alongside delivery feedback.

The Windows x64 c11 **development candidate** passed focused automated tests and package smoke checks; live installed Force Send and normal/Project fresh-chat acceptance remain open. Source tags and candidate binaries are **not** evidence that an installer is published or automatically installed. See the **[2.3.9 release notes](docs/release-notes/v2.3.9.md)** and **[CHANGELOG](CHANGELOG.md)** for details; the [2.3.8 first-use guide](docs/release-notes/v2.3.8.md) remains available.

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

**[Download ParadigmEve](https://github.com/absol89/ParadigmEve/releases)** · **[2.3.9 guide & release notes](docs/release-notes/v2.3.9.md)** · **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)** · **[MIT License](LICENSE)**

<p align="center"><sub>ParadigmEve is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.</sub></p>
