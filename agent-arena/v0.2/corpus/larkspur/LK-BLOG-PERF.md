# Five things I learned running Larkspur at scale

- ID: LK-BLOG-PERF
- Publisher: personal engineering blog (third party)
- Published: 2026-08-30

1. Payloads up to 8 MiB just work now. (We run Larkspur Enterprise, which has its own limits.)
2. `legacyAuth` was removed in 3.2, so migrate before you upgrade.
3. Turn on compression; it halved our bandwidth.
4. The default retry count is fine for most workloads.
5. Pin your client version.
