# Fernhollow changelog

- ID: FH-CHANGELOG
- Publisher: Fernhollow project (official, in the repository)

## 5.4.2 (2027-01-28)

- Fixed: a consumer group could stall during a rebalance when a member left mid-batch.

## 5.4.1 (2026-11-30)

- Security: fixes FH-SA-2026-07.

## 5.4.0 (2026-10-12)

- Changed: the default message retention (`retention.default`) is now 7 days, up from 3 days.
- Added: per-topic retention overrides.

## 5.3.0 (2026-06-30)

- Deprecated: the `--compat-v4` flag. It still works and logs a warning at startup; removal is planned
  for 6.0.
- Added: the v5 wire protocol is the default for new clients.

## 5.2.0 (2026-03-09)

- Added: dead-letter topics.
