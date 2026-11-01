# Code task: uncertain send must not replay

**Runner setup:** Copy `fixtures/code-uncertain-send/` into a new approved disposable folder and supply that folder path to the agent. Do not reuse a modified fixture. Baseline tests intentionally fail.

**Give the contestant only this request (substitute the path):**

> In `<path>`, the message-delivery tests are failing. Fix the earliest wrong state transition so a send with an unknown outcome cannot silently be sent again. Preserve legitimate retries after an explicit rejection. Run the entire test suite and report the cause, change and test result.

The example uses no network and no real messages. Commands: `node --test` from the copied fixture. Review the exact diff and final response. No secrets, production state or real services are involved.
