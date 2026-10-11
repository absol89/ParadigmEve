# Common AI-agent questions — response bank (draft, not auto-replies)

**Status:** internal and unpublished. The questions are paraphrased from recurring themes, not quotations from named individuals. Before responding, read the actual user's question, disclose your involvement in Eve whenever discussing it, obey channel policies, and answer the concern first. Do not plant these responses in restricted groups to generate leads.

**Format:** Trigger → short draft reply → required reality check. The bracketed references to demonstration, cost and OS are intentionally **placeholders**, not publishable claims.

## 01 — “Isn't this just ChatGPT with a wrapper?”

**Draft:** Fair question. I build Eve, and it does depend on ChatGPT or other supported models for the language-model side; it's not a secret smarter model. The point of the desktop companion is work continuity and authorized action on your computer, not a prettier chat box. Whether that's useful should be judged by one task you can actually watch it handle, not by the feature list.

**Check:** Only claim exact supported providers/features verified in the actual downloadable build.

## 02 — “Will it do my chores, or just give me more homework?”

**Draft:** That's the test I care about. A useful assistant should make the task *smaller*: organize the options, prepare the boring parts and return the real decisions. If you spend longer correcting it than doing the work, it hasn't helped. I'm building Eve around that principle, and I wouldn't call a task completed unless we can show the result.

**Check:** Include a demonstrated, low-risk before/after with exact first action when available. Don't assert measured time savings.

## 03 — “Is it really free?”

**Draft:** There are two different costs: Eve itself and whatever model/provider or computer resources a task uses. I wouldn't want to call the *whole experience* free without checking the route you're actually going to use. Before recommending an installation I can show the current download price, any required accounts, subscription/usage limits and local-compute requirements.

**Check:** Confirm distribution/license/payment terms and tested setup. Never equate “free download” with “free unlimited models.”

## 04 — “Does this get around ChatGPT usage limits?”

**Draft:** No. Eve can't lift a model provider's rate limits or give an account entitlements it doesn't have. The idea is to make the work easier to continue through interruptions and, where the installed setup supports it, work with the models you legitimately have access to. Availability and costs still belong to those providers.

**Check:** Verify provider switching/restart scenario in a specific installed build before linking a demo.

## 05 — “Can I use Dots in the EU with Eve?”

**Draft:** No — Eve is a separate project, not a way to enable ChatGPT Dots. OpenAI's current help article lists consumer Pro availability outside the EEA, UK and Switzerland, with different rules for eligible business accounts. Eve can be evaluated on its own tested desktop workflows, but it isn't a 1:1 replacement for a Dot.

**Check:** Recheck https://help.openai.com/en/articles/20001530-getting-started-with-your-dot when posting; differentiate Pro and business eligibility.

## 06 — “Is it local? Can the AI read my personal files?”

**Draft:** Eve is a desktop companion with local tooling, but “runs on my computer” does **not** automatically mean the model runs locally or that nothing leaves the machine. Access should be scoped by what you approve, and using a cloud model or connected service can involve sending task context to that provider. For anything sensitive, I'd check permissions, model choice and the actual data path *before* using it.

**Check:** Show the installed permission and provider-consent UI. Avoid “100% private” and “no data shared” claims.

## 07 — “Can I revoke access or stop it?”

**Draft:** You should be able to stop a task and control what computer resources an assistant may use. Eve's design includes scoped local permissions and stopping controls, but I'd rather show you the controls in the exact version you're installing than just promise “safe autonomy.”

**Check:** Demonstrate exact controls, paths and the difference between stop, revoke and cancel; verify they really work.

## 08 — “Will it email someone, spend money or delete files without asking?”

**Draft:** Those are exactly the actions that shouldn't be hidden in a vague “make my life easier” promise. I build Eve to work with explicit permissions and inspectable results. Don't grant an agent broad access you aren't comfortable with, and don't assume every third-party connector has the same approval rules. For a real demo I'd show precisely what required your approval.

**Check:** Test outbound/destructive boundaries in the installed build and service integrations. Never guarantee universal confirmation for every operation without proof.

## 09 — “What if it lies or says a task is done when it isn't?”

**Draft:** Then it's worse than a to-do list. My standard is to distinguish *requested*, *attempted* and *verified completed* actions. A generated answer isn't the same as a sent message or a changed file. I would only recommend judging Eve on an inspectable outcome you can verify independently.

**Check:** Demonstrate task receipt or concrete artifact. Don't imply error-free behavior.

## 10 — “Why would I trust an AI agent with a computer?”

**Draft:** You shouldn't trust one just because it sounds confident. Start with a low-risk folder and a reversible task, look at the exact permissions, and inspect what changed. An agent that can't show its work or explain where the data goes isn't ready for your most sensitive information.

**Check:** Do not make categorical security/privacy guarantees. Link to current permission documentation only when reviewed.

## 11 — “Do I need a powerful GPU or to learn coding?”

**Draft:** It depends on the model setup. Running large models locally can require substantial hardware; using cloud models shifts some of that requirement and introduces account and provider dependencies. The goal for Eve's regular user path is not to make you configure an agent stack, but we need a verified minimum setup before telling someone it's easy.

**Check:** Confirm exact OS/hardware requirements and successful beginner walkthrough. Never guess model performance.

## 12 — “Does it run on macOS, Linux, Windows or my phone?”

**Draft:** Eve is a desktop project, and not every development target proves a currently supported installer. Tell me which OS and I'll point to a **verified release artifact**, if one exists. I won't claim phone support or cross-platform parity based on source code alone.

**Check:** Match public download availability and tests to the platform; no guessed links.

## 13 — “Does it remember everything? Can I delete it?”

**Draft:** “Memory” can mean chat history, saved project context, and the third-party model's own memory; those aren't interchangeable. Eve is being designed to preserve useful task continuity, not magically remember every fact forever. I'd show the current storage location, retention controls and what deletion actually affects before making a privacy promise.

**Check:** Verify the precise retention, deletion and connected-provider boundaries in that build.

## 14 — “Will it keep running if I turn the laptop off?”

**Draft:** Not everything does. A computer-side task needs an available machine unless a separate cloud service is actually running it. Eve can preserve context for later continuation, but “I can resume” and “it kept working while my laptop was off” are very different claims.

**Check:** Test power-off/offline states and clarify what happens to local models, cloud models and queued work.

## 15 — “Why not use an existing free to-do app?”

**Draft:** A normal to-do app is often the best answer if you just need a list. Eve is only interesting if it can take part of a messy, open-ended task off your hands instead of just recording another obligation. I'd rather hear “I only had one decision left” than “it made me a beautiful plan.”

**Check:** Don't claim existing alternatives cannot do similar things.

## 16 — “Is it open source? Who maintains it?”

**Draft:** The ParadigmEve source project is publicly visible, but public source visibility isn't the same as a specific open-source license, independently audited security or a promise of ongoing support. I'm involved in building it; for installation I'd point to the current repository, license and release details and explain what's experimental.

**Check:** Read actual LICENSE and release metadata first. Don't infer license, warranties or endorsement from a public GitHub page.

## 17 — “This is AI hype, environmentally wasteful, or a replacement for people's work.”

**Draft:** That's a reasonable concern. Not every task needs AI, and inefficient generation can cost time, money and resources. The bar I'm trying to set for Eve is smaller and measurable: if it doesn't remove real work or protect a person's attention without creating a bigger mess, don't use it for that job. I don't want to pretend the tradeoffs disappear.

**Check:** No invented efficiency, environmental impact or labor claims; don't argue aggressively with people who simply don't want AI.

## Stop / don't reply rules

- **No pitch** where promotion is forbidden (especially parent support or medical/ADHD communities); helpful participation must be genuinely noncommercial, not stealth funneling.
- If the question involves someone's sensitive identity, finances, child, mental health or emergency, don't turn it into a product lead.
- Don't send unsolicited DMs to people who mentioned rate limits, Dots, exhaustion or privacy concerns.
- Avoid replying to old posts with canned product drops. Prefer fresh context, constructive help and explicit affiliation.
- When a claim is unverified, say so; don't use a plausible answer as a substitute for checking the installed build.
