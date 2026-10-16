# Eve tasks

Work handed to Eve as a single, bounded focus. Each task has its own file with:

- the goal, scope and what is explicitly out of scope;
- the upstream or in-repo references to start from;
- the ParadigmEve rules the work must keep;
- acceptance criteria and how to report back;
- a **Prompt for Eve** section to paste into a fresh Eve chat. It asks her to restate the brief, plan, and
  confirm before she changes anything.

A task file is the brief, not a progress log. Eve reports progress in her chat and in the task's **Status**
line, and anything durable she learns goes into the Vault or `AGENTS.md` as usual.

Release identity comes from **GitHub version tags** and actual release assets, not from the
numbered labels of historical local test packages. Treat automated source checks and **installed
self-testing** as different evidence: a passing source test does not imply that the same bytes
were installed. The `%instructions` category holds saved reusable prompts without Pins; preserve
exact internal identifiers and old artifact filenames when documenting historical evidence.

| Task | Target | Status |
| --- | --- | --- |
| [Workspace docks: Files, Terminal, Agents, Review](workspace-docks.md) | 2.3.1 | Ready to start |
| [2.3.1 black-box test checklist](test-plan-2.3.1.md) (shared with Claude) | 2.3.1 | Waiting for a frozen candidate |
| [Bundled pets: a cat and a dog](bundled-cat-and-dog.md) | 2.3.2 | Shipped, art reopened below |
| [Bundled pets: redo the cat and dog art from the chibi references](bundled-pets-art-redo.md) | 2.3.2 | Ready to start |
