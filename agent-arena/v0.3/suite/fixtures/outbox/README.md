# Notification outbox

Messages are written to an outbox table and delivered to an external provider by one or more workers.

## Row lifecycle

| Status | Meaning |
| --- | --- |
| `pending` | Waiting to be sent. Claimable once `nextAttemptAt <= now`. |
| `sending` | Claimed by a worker that holds a lease (`owner`, `token`, `expiresAt`). Only the lease holder may record the outcome. |
| `acked` | The provider confirmed delivery. Terminal. |
| `uncertain` | The provider may or may not have delivered it. Never sent again automatically; waits for a late provider ACK or an operator decision. |
| `dead` | Rejected `maxAttempts` times. Terminal. |

- An explicit rejection is safe to retry: the row goes back to `pending` after a backoff delay.
- A provider ACK can arrive late (after the worker timed out, or after a restart) and can be delivered
  more than once. Each message counts as delivered at most once.
- Operators resolve `uncertain` rows with `resolveUncertain(id, 'delivered' | 'requeue', now)`.

Run the tests with `npm test` (Node 20 or newer, no dependencies).
