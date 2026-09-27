# Agent hooks, prompt skills, and reusable context — market scan

Date: 2026-09-16

This is a bounded product-research note for ParadigmEve. It compares the current public customization surfaces around agent hooks, reusable prompt/skill systems, and plugin packaging. It is not an implementation plan and does not change current Eve behavior.

## Executive takeaway

The market is converging on four technical layers:

1. **Persistent instructions / rules** — always-on or scoped guidance such as `AGENTS.md`, Cursor Rules, or repository instructions.
2. **Skills** — reusable task workflows loaded when relevant, increasingly packaged as `SKILL.md` plus optional scripts and references.
3. **Hooks** — deterministic lifecycle interception around prompt submission, tool calls, subagents, compaction, stopping, and session boundaries.
4. **Plugins** — distributable bundles that combine skills, hooks, agents, commands, MCP servers, and other resources.

ParadigmEve already has something importantly different from all four: **Threads are human-visible, durable context spaces with a standing prompt and Pins that the user intentionally activates with `%thread`**. That should remain a separate product concept rather than being renamed into “skills” or implemented as a hidden hook.

The strongest opportunity is interoperability: let Eve understand common skill packages and hook concepts while preserving Threads as the user-facing context layer.

## What the major systems are doing

### Claude / Anthropic

Anthropic's Agent Skills model uses progressive disclosure. Skill name/description metadata is available up front, the full `SKILL.md` is read only when the skill becomes relevant, and supporting files are loaded only as needed. Their authoring guidance explicitly treats context as scarce and recommends concise skill bodies with deeper material split into references/scripts.

Claude's agent SDK exposes lifecycle hooks including `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, and `PreCompact`. Hooks can inspect or alter relevant execution data; for example a prompt hook can update the submitted prompt and a pre-tool hook can deny a dangerous action.

**Product lesson for Eve:** skills should be discoverable cheaply and expanded lazily. Hooks are strongest when they enforce or observe execution boundaries rather than carrying large standing instructions.

Sources:

- https://docs.claude.com/es/docs/agents-and-tools/agent-skills/best-practices
- https://docs.claude.com/it/api/agent-sdk/python

### Cursor

Cursor now separates Rules, Skills, Hooks, Agents, Commands, MCP servers, and Plugins. Rules are persistent prompt context. Skills are reusable specialized workflows and may be invoked manually or selected by relevance. Hooks can run before/after agent-loop events and may observe, block, modify behavior, or inject context. Cursor also supports prompt-evaluated hooks in addition to command hooks on compatible surfaces.

Cursor's plugin packaging is notable because a plugin can combine rules, skills, agents, commands, MCP servers, and hooks. It also explicitly supports loading Claude Code hook configurations, which is evidence that compatibility is becoming a product feature rather than every vendor insisting on a completely isolated format.

**Product lesson for Eve:** keep the concepts composable. A Thread should not need to become a hook just because it sometimes triggers one, and an installed package should be able to contribute several different surface types without merging their authorities.

Sources:

- https://prod.cursor.com/docs/rules
- https://prod.cursor.com/docs/skills
- https://prod.cursor.com/docs/hooks
- https://prod.cursor.com/docs/plugins
- https://prod.cursor.com/docs/reference/third-party-hooks

### GitHub Copilot

GitHub Copilot exposes agent hooks at lifecycle points such as session start/end, prompt submission, and tool execution. Project hooks live in repository configuration, while CLI also supports user and policy levels. GitHub's hook documentation emphasizes uses such as security checks, audit logging, validation, and tool allow/deny decisions.

Copilot also supports Agent Skills as folders containing instructions, scripts, and resources. GitHub describes the Agent Skills format as an open standard and supports project and personal locations including `.github/skills`, `.claude/skills`, `.agents/skills`, `~/.copilot/skills`, and `~/.agents/skills`.

Copilot Plugins then bundle custom agents, Skills, Hooks, MCP configuration, and LSP configuration.

The CLI additionally supports **prompt hooks** at `sessionStart`, which can automatically submit natural language or a slash command. This is conceptually close to a bootstrap/self-prompt mechanism, but it is still distinct from persistent rules and on-demand skills.

**Product lesson for Eve:** there is strong value in treating “prompt injection at a lifecycle boundary” as its own explicit event type rather than smuggling it into generic persistent instructions.

Sources:

- https://docs.github.com/en/copilot/concepts/agents/hooks
- https://docs.github.com/en/copilot/reference/hooks-reference
- https://docs.github.com/en/copilot/concepts/agents/about-agent-skills
- https://docs.github.com/en/copilot/concepts/agents/about-plugins

### OpenAI Codex / Agents SDK

OpenAI's earlier public skills catalog is now marked deprecated in favor of the OpenAI Plugins direction. Current Codex examples use skills, plugins, hooks, `AGENTS.md`, MCP, and custom agents as separate customization surfaces. OpenAI's own migration material maps Claude skills into `.agents/skills/` and Claude hooks into `.codex/hooks.json`, while warning that the hook runtimes are not one-to-one.

The current migration notes show that Codex hook coverage is still narrower than Claude's in several areas and that some hook types or execution modes do not map directly. That is useful evidence against designing ParadigmEve around one vendor's exact event vocabulary.

Separately, the OpenAI Agents SDK supports dynamic instructions and run/agent lifecycle hooks around agent start/end, LLM calls, tools, and handoffs. That is a developer-level orchestration surface rather than a user-facing skill library, but the architecture reinforces the same split between prompt authority and lifecycle observation.

**Product lesson for Eve:** define Eve's own small semantic hook contract first, then build compatibility adapters. Do not let a Claude/Codex/Cursor event name become the durable internal product model.

Sources:

- https://github.com/openai/skills
- https://github.com/openai/skills/blob/main/skills/.curated/migrate-to-codex/references/differences.md
- https://github.com/openai/openai-agents-python/blob/main/docs/agents.md

## The clearest market pattern

The useful distinction is not “prompts versus code.” It is **when and why a piece of guidance becomes authoritative**.

| Surface | Best use | Activation | Should it mutate execution? |
| --- | --- | --- | --- |
| Persistent rule | Stable conventions and boundaries | Always / scoped automatically | Usually no; guidance only |
| Skill | Repeatable specialized workflow | Relevance or explicit invocation | Through the agent's normal tools |
| Hook | Enforcement, observation, context injection at a lifecycle point | Deterministic event | Yes, but narrowly and explicitly |
| Plugin | Distribution/package boundary | Installation | Depends on included components |
| **ParadigmEve Thread** | User-visible durable context, preferences, and standing intent | Explicit `%thread` or Start chat from Thread | Not by itself; it shapes the current task |

This is a useful product boundary for Eve because it explains why `%expenses` and `%organize` feel natural. They are not merely functions. They establish a recurring context and way of working, while the actual tools and project data remain separate authorities.

## Implications for ParadigmEve

### 1. Keep Threads human-facing

Do not rename Threads to Skills. A Skill is normally an implementation/workflow asset discovered by an agent. A Thread is a place the human recognizes and returns to. `%expenses` can eventually *use* an expense-analysis skill, but the user should still think “I am in my Expenses Thread,” not “I loaded SKILL.md.”

### 2. Add progressive disclosure if Eve gains Skills

A future Eve Skill format should follow the emerging pattern:

- cheap metadata available for discovery;
- full instructions loaded only after selection;
- detailed references/scripts loaded only when necessary;
- explicit version/source information;
- no need to stuff every installed skill into every fresh-chat prompt.

This is especially valuable for Free ChatGPT/browser-backed Eve, where prompt budget and fresh-account comprehension matter.

### 3. Hooks should be mechanical first

Good first-class hook jobs for ParadigmEve would be things such as:

- before a destructive file operation: policy/check/ask;
- after a file edit: formatting or verification trigger;
- before/after worker dispatch: audit or project-specific gate;
- before compaction: save/verify required durable context;
- at a verified turn/session finish: run a bounded cleanup/checkpoint action;
- on Thread activation: optionally contribute a small deterministic context fragment.

The hook should not become another hidden long prompt that competes with the Thread prompt, current user request, project `AGENTS.md`, or Pins. When hooks can add model context, that output should be bounded, labeled by source, and lower-authority than the current authored user request.

### 4. Model hook merging explicitly

Cursor and Copilot both have multiple hook sources/scopes. ParadigmEve will eventually need a deterministic answer when installation policy, project configuration, plugin, Thread, and user-level hooks all fire.

The clean model is likely:

- collect all matching hooks;
- preserve source identity;
- execute in a documented order;
- make deny/gating semantics deterministic rather than “last text wins”;
- concatenate bounded context additions with provenance;
- never allow a lower-authority hook to silently erase a higher-authority safety/policy decision;
- record what actually ran.

This fits ParadigmEve's existing “one meaningful fact, one owner” discipline better than arbitrary prompt concatenation.

### 5. Consider Agent Skills compatibility, not just an Eve-only format

GitHub, Anthropic, Cursor, and OpenAI are converging around `SKILL.md`-style packages and `.agents/skills` compatibility. Eve could eventually inspect/import those packages while adding Eve-specific metadata separately.

A useful compatibility story could be:

- **Native Eve Skill:** richer metadata/capability declarations when available.
- **Agent Skill import:** read ordinary `SKILL.md` packages without rewriting them.
- **Thread binding:** a Thread may recommend or activate one or more Skills without duplicating their bodies into its prompt.
- **Plugin binding:** an Eve plugin may bundle Skills + hooks + connector/MCP definitions while each keeps its own authority.

That would let ParadigmEve participate in the emerging ecosystem rather than creating another isolated prompt-folder convention.

### 6. `%thread` is potentially a differentiated UX layer

Most competitor customization is developer-facing: config files, dot-folders, markdown instructions, slash commands, or plugin marketplaces. ParadigmEve's Thread/Quilt model can make the same power understandable to a non-developer:

- “Expenses” is a durable place with remembered preferences.
- “Organizer” is a durable way Eve helps with chosen folders.
- Pins show what context was intentionally kept.
- Quilts group related Threads without silently activating all their prompts.

That explicit visible activation is worth protecting. It provides a user mental model that hidden relevance-based skill selection does not.

## A possible future vocabulary

No source change is proposed here, but the clean conceptual vocabulary would be:

- **Thread** — human durable context and standing intent.
- **Pin** — one saved useful context item in one Thread.
- **Quilt** — broader grouping/context discovery across Threads.
- **Skill** — reusable agent workflow/instructions/scripts, discovered or explicitly invoked.
- **Hook** — deterministic lifecycle reaction or gate.
- **Plugin** — installable bundle that can contribute Skills, Hooks, tools/connectors, and optional Thread templates.
- **Plan** — visible user work/progress, not a Skill or Hook.

The main rule is: **activation should never be ambiguous**. A Thread activation, Skill invocation, hook event, plugin install, and user message are different facts and should remain separately inspectable.

## Near-term research ideas, not implementation commitments

1. Prototype a read-only Agent Skill importer against a few public `SKILL.md` packages and measure how much normalization Eve actually needs.
2. Draft a tiny semantic hook event vocabulary based on Eve's own lifecycle, then map Claude/Cursor/Copilot/Codex events onto it to find gaps.
3. Dogfood one non-destructive hook such as “after edit → suggest/run focused validation” before allowing hooks to block or mutate actions.
4. Test whether a Thread that references a Skill feels clearer than putting the whole workflow into the Thread prompt.
5. Explore plugin packaging where a tutorial installs a Thread template + Skill + optional MCP connector without exposing those implementation nouns unless the user wants them.

## Bottom line

The market is standardizing around **Skills for reusable cognition and Hooks for lifecycle control**. Plugins are becoming the packaging layer around both. ParadigmEve should probably interoperate with that direction, but its strongest differentiator is not another skill format: it is the visible, persistent human context model of **Threads + Pins + Quilts**, with the current authored request remaining authoritative.

That suggests a product architecture where Threads choose the human context, Skills supply reusable procedure, Hooks enforce lifecycle rules, Plugins distribute capabilities, and each remains a separately observable fact.
