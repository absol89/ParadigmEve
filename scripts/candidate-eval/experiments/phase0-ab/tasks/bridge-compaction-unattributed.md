# A compacting chat gets reloaded because of its replacement's tool calls

During Compact & Resume the app captures the old chat's continuation brief and then waits for the
replacement chat. While it waits, MCP tool calls that the app cannot attribute to any chat
("unattributed activity") can arrive; at that point they belong to the replacement page, whose own
evidence is not reported until its marked message commits.

The unattributed-activity recovery in `src/main/bridge.ts` nevertheless suspects the old,
compacting chat: after the reconnect grace period it schedules a reconnect / repair and finally
reopens (reloads) that chat.

Expected: a chat whose compaction brief has been captured and is waiting for its replacement is
never suspected by unattributed-activity recovery. With its brief ready and unattributed calls
arriving, after the grace period (and well beyond it) there are no reconnects, no repairs and no
reopen of that chat.

Actual: the compacting chat is suspected, and a reconnect/repair/reopen of it is scheduled.
