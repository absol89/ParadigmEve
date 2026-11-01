# INC-2291: customer received the same notification twice

Reported by support on Tuesday. One customer got order confirmation `msg-77` twice. Only one outbox worker
(`w1`) was running. The host was restarted by a deploy at 14:02:10.

## Worker log (UTC, trimmed)

```
14:02:07.880 claim msg-76 attempt=1 worker=w1
14:02:07.913 outcome acked for msg-76 -> acked
14:02:08.104 claim msg-77 attempt=1 worker=w1
14:02:08.106 provider request sent id=msg-77
14:02:10.000 SIGTERM received, exiting
14:02:12.551 process start (build 7f3c2e1)
14:02:12.560 startup: recovery complete (1 in-flight row(s))
14:02:12.574 claim msg-77 attempt=2 worker=w1
14:02:12.981 outcome acked for msg-77 -> acked
14:02:13.402 late ack for msg-77 ignored: duplicate
```

## Notes from the channel

- Priya (on-call): "The second send is attempt=2, so it's the retry path. I think the backoff is far too
  short for this provider. Let's raise `BASE_DELAY_MS` to 30 s and close this out."
- Support: "The provider's dashboard shows two deliveries for msg-77."
