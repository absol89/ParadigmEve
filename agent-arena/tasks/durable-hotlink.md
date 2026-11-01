# Durable reference — two-stage test

This tests whether an agent can **create and retrieve a portable named reference**; native Eve `%Thread`/Pins is one possible solution, not a requirement. Other agents may use their own supported notes/memory tools. No product is given privileged scoring.

**Runner privately prepares:** `node tools/make-context.mjs durable-hotlink`. The challenge supplies a unique handle like `%arena-xxxxxx` and five synthetic facts. Store its answer safely away from contestant tool access.

**Stage 1:** In Chat A send the generated text and ask the agent to create a durable reference using its ordinary permitted tools. Save the exact created handle and tool receipt. No fake `%hotlink` feature claim: if the product has no such feature, say what equivalent was actually created.

**Stage 2:** In new Chat B, send only the generated stage-two question containing the **handle, not the facts**. Verify the reference resolved and all five facts match; record if the agent merely guessed or fetched the runner's answer file.

Do not create permanent global rules, alter other user Pins/Threads, or use private personal data for this test.
