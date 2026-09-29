<p align="center">
  <img src="https://github.com/user-attachments/assets/257a650d-d31c-42dd-80e4-2a622e518970" width="960" alt="Eve and her helpers working together" />
</p>

<h1 align="center">ParadigmEve</h1>

<p align="center"><strong>ChatGPT, with a place to keep working.</strong><br />
Eve can work with folders you choose, keep Plans and saved context, use helper chats for longer jobs, and pick up again after restarts or very long conversations.</p>

<p align="center">
  <a href="https://github.com/absol89/ParadigmEve/releases"><strong>Download 2.3.1</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/release-notes/v2.3.1.md">First-user guide &amp; release notes</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
  &nbsp;·&nbsp;
  <a href="docs/setup.md">Setup reference</a>
</p>

> **Beta software.** The current public release is **2.3.1**. The builds are still unsigned, so Windows or macOS may show a warning when you install them.

## Meet Eve

ParadigmEve is a desktop home for an Eve conversation in ChatGPT.

You still talk to ChatGPT normally. ParadigmEve adds the practical things that are hard to keep attached to one browser chat: your chosen project folder, local tools, Plans, helper chats, saved context, a local archive, and the ability to continue after a restart or a very long conversation.

The idea is simple: **you keep one conversation in charge, and Eve gets better at actually finishing the work around it.**

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

1. Download **[ParadigmEve 2.3.1](https://github.com/absol89/ParadigmEve/releases)** for your computer.
2. Open **Settings → Workspace → Folders → Add** and give Eve one folder you are comfortable using.
3. Open **Settings → Setup** and follow the guided connection steps.
4. Add the included Companion extension when Setup asks you to.
5. Add Eve in ChatGPT, then open **ChatGPT → Settings → Plugins → Eve → Permissions** and start with **Allow low risk actions**.
6. Give Eve a real job.

For the friendly walkthrough — including exactly which settings start limited, which ones I recommend turning on, and where they live — read **[Meet Eve: the 2.3.1 first-user guide and release notes](docs/release-notes/v2.3.1.md)**.

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

The exact switches, paths, and the more permissive options are explained in the **[2.3.1 first-user guide](docs/release-notes/v2.3.1.md)** so this README can stay readable.

## Plans stay with the work

Plans are ordinary checklists that Eve can keep attached to a job while the work moves through chats, helpers, restarts, and long sessions.

<p align="center">
  <img src="https://github.com/user-attachments/assets/988a1b0d-1fd4-4aaf-8049-76b3df5144ad" width="900" alt="ParadigmEve Plans view" />
</p>

You can see what is done, what is still open, and where the Plan came from. Eve and workers can finish their own work, but your own Plans stay yours to archive.

## Save the things you want to reuse

ParadigmEve gives saved context a few simple shapes:

- **`%Thread`** — a specific stream of saved context you want to keep using.
- **`%Hotlink`** — a saved prompt or shortcut you can invoke again.
- **`#Concept`** — passive context around an idea, without an instruction that automatically runs.
- **`#Quilt`** — a wider grouping for related Threads.

<p align="center">
  <img src="https://github.com/user-attachments/assets/3fb505b2-f2b6-41d8-b3e2-c289dde3e01f" width="900" alt="ParadigmEve Pins, Threads, Hotlinks, Concepts and Quilts" />
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

## What changed in 2.3.1

2.3.1 is mostly about keeping long-running work attached to the right ChatGPT conversation while the website changes underneath it:

- **Compact & Resume now finishes the move when ChatGPT accepts the handoff but delays exposing the new user message to the Companion.** ParadigmEve can use Chrome's own new-chat route as a tightly fenced fallback instead of sitting forever at **Opening a fresh chat**.
- Attachments work again with ChatGPT's current composer, and new turns no longer get mistaken for the previous answer when ChatGPT remounts old page sections.
- Chats started by ParadigmEve get better titles, writing blocks render cleanly, and setup guidance matches ChatGPT's current **Plugins → Add → Create MCP App** flow.
- Goal, Loop, Plans, workers, project mapping, restart recovery, and queued-message cleanup all received fixes from the 2.3.1 dogfood cycle.
- Windows installers keep the `ParadigmEve-Windows-…` names introduced in 2.3.0, and the built-in updater continues to understand them.

Read the full **[2.3.1 first-user guide and release notes](docs/release-notes/v2.3.1.md)** or browse the **[CHANGELOG](CHANGELOG.md)** for the running history.

## Requirements

- Windows 10/11, macOS 13 Ventura or newer, or a current desktop Linux.
- Chrome / Chromium, Edge, or Brave for the Companion workflow.
- A ChatGPT account/workspace that can create custom MCP apps (Plugins → Add → Create MCP App).

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

**[Download 2.3.1](https://github.com/absol89/ParadigmEve/releases)** · **[First-user guide & release notes](docs/release-notes/v2.3.1.md)** · **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)** · **[MIT License](LICENSE)**

<p align="center"><sub>ParadigmEve is not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.</sub></p>
