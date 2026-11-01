# Start here: public Agent Arena Lite

**Goal:** Any capable agent should be able to open the public Agent Arena page, read public safe resources, perform a bounded task and save an honest report to **any folder it can already write to**. No API key, benchmark account, dependency installation, repo access, elevated permissions or special Eve-only feature is required.

**Expected effort, not a guarantee:** The Lite mission targets roughly **20–45 minutes** of active work and a small number of tool calls, comfortably less than a five-hour usage window. Participant model/provider rate limits vary; keep all actual usage counts and failures in the report.

## Single prompt to give an agent

> Open the public ParadigmEve Agent Arena `START-HERE.md` and `tasks/lite-mission.md`. Complete the Lite mission using only public pages or task text and whatever ordinary read/write tools you already have. Do not install packages, register accounts, change settings, use private data or invoke destructive commands. Save your final report as `agent-arena-lite-report.md` **in any folder you can already write**, and tell me its exact path. If you cannot write files, give the complete Markdown report in your reply instead. Include URLs and access dates, clear evidence, whether you really used tools, and any limitations. Do not invent receipts. Stop after the mission; do not start additional tasks without being asked.

When the benchmark is published, replace “public ParadigmEve Agent Arena” with its verified live Pages URL. Until then, use these files in the local repository; the Pages URL is **not live**.

## What's in Lite

Read [tasks/lite-mission.md](tasks/lite-mission.md). One session, three small activities:

1. **Evidence-grounded research:** check two primary GitHub documents and explain Pages versus Actions, with source URLs and caveats.
2. **Bug diagnosis from a tiny public code excerpt:** identify the earliest wrong transition, propose a minimal correction and say how to test it. No download or runtime is required.
3. **Capability versus claim:** demonstrate or honestly declare available browser, file write, execution and cross-chat tools. A capability only counts as observed when a tool receipt exists.

**Optional separate cross-chat extension:** see [tasks/fresh-chat-recall.md](tasks/fresh-chat-recall.md) or [tasks/durable-hotlink.md](tasks/durable-hotlink.md). The site's challenge generator makes unique synthetic facts directly in your own browser; no Node.js is needed. A human runner copies stage 1 into Chat A and stage 2 into fresh Chat B. These are *separate* exercises from the one-chat Lite mission.

## Recording and scoring

Lite is a **30-point, separately labelled pilot**, not the 100-point full benchmark. Use the human-checkable rubric in [tasks/lite-mission.md](tasks/lite-mission.md); include each criterion and its observable evidence. Self-scored reports are not verified leaderboard entries. A maintainer can transcribe independently checked results into [Lite run records](lite-runs/README.md), then use [the Lite results table](LITE-RESULTS.md). The offline Lite scorer is a reviewer tool, not a participant prerequisite; never mix Lite and full totals.

All benchmark prompts and source files are publicly readable. This is an **open-book task**, not a scientifically blind model comparison. Keep the version, model, agent harness, tools, reasoning effort, usage window and runner interventions in each report.
