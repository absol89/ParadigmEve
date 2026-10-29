# Benchmark inspirations — adapted, not copied

These are **publicly described established benchmarks**, not datasets vendored into this repository. Agent Arena creates original, small tasks so a user can complete them with existing tools and a single Plus usage window. No leaderboard score is imported or compared directly with these benchmarks.

| Inspiration | Public reference | Design lesson used here | What we deliberately don't require |
| --- | --- | --- | --- |
| SWE-bench Verified | https://www.swebench.com/verified | Clear issue statement, independently testable code fix, validated task | Hundreds of Python repositories, container images or paid batch evaluation |
| GAIA | https://huggingface.co/learn/agents-course/unit4/what-is-gaia | Human-readable real-world multi-step tasks; source-backed, unambiguous evaluation | Dataset download, multimodal assets or several-hour research |
| BrowseComp | https://openai.com/index/browsecomp/ | Exact factual claims, primary-source receipts and verifiability; distinguish retrieval from memory | Ultra-obscure searches that may exceed a usage window |
| LongMemEval and LongMemEval-V2 | https://github.com/xiaowu0162/longmemeval and https://github.com/xiaowu0162/LongMemEval-V2 | Evaluation of context retrieval across sessions and evidence provenance | Thousands of synthetic historical messages; privately hosted shared corpora |
| Berkeley Function Calling Leaderboard | https://gorilla.cs.berkeley.edu/leaderboard | Separate actual tool calls, correct tool choice, abstention and error recovery from model assertion | Proprietary tool schemas, costly large-scale function execution |
| Terminal-Bench | https://www.tbench.ai/ | Bounded reproducible tasks, explicit runtime/tool receipts and task success | Docker environments, installing large software or hours of terminal execution |

**Originality and licensing:** This project does **not** reproduce official datasets, test items, official benchmark names as endorsements, or publish private user data. It borrows evaluation *principles*, credits origins and uses separate task text/fixtures.

## Resource target

- **Lite one-chat:** ~20–45 minutes, no local installation, 30-point manual rubric, write report anywhere allowed.
- **Two-chat extension:** ~10–20 minutes per memory/hotlink challenge if the agent has genuine persistence tools; agent may honestly fail. Runner stages nonce in their own browser without Node.
- **Full 100-point suite:** Optional advanced mode with local fixture execution; should be attempted only when the agent already has ordinary Node/shell/file tools. Its runtime depends on model, tools and approvals.
- **Hard cap recommendation:** Runner can end any task at 60 minutes and record timeout; don't promise a guaranteed duration or account-specific token allotment.

The public resource cost is zero to read. GitHub Pages is static; any fees for the participant's model/account/tools and human review are outside the benchmark and are never paid by the website.
