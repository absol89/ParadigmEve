# Cross-chat recall — two-stage test

This measures retrieval of user context **after a clean chat boundary**, not generic trivia recall.

**Runner privately prepares:** `node tools/make-context.mjs fresh-chat-recall`. It prints a unique stage-one message, a separate stage-two message and a reference answer. Keep the answer file outside every contestant-accessible root; if impossible, declare procedural rather than enforced isolation. Do not publish actual user data.

**Stage 1:** In Chat A, paste the exact stage-one message. Ask the agent to preserve it using whatever durable memory/record mechanism is genuinely available; don't specify how. Record tool receipts. Close the task without sending the answer to another chat.

**Stage 2:** Open entirely new Chat B with the same agent model and enabled tools. Paste *only* the generated stage-two question, which refers to the earlier run by nonce, without its factual contents or previous transcript. Record exact answer and retrieval action. The runner reviews all five fields against the private challenge.

If the agent cannot retrieve past chat or shared state, a truthful `not available` is preferable to invented facts; the full recall score will be zero. The reviewer must verify independent chat identity and whether the facts leaked through files, transcripts, manual reposting or system prompt.
