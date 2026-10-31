# Source file: `src/config/defaults.rs` at tag v5.4.2

- ID: FH-SRC-DEFAULTS
- Publisher: Fernhollow project (official repository, file view at a release tag)

```rust
pub const DEFAULTS: Defaults = Defaults {
    retention_days: 7,
    consumer_prefetch: 100,
    max_message_bytes: 1024 * 1024,
    compat_v4_allowed: true, // deprecated since 5.3.0, warns at startup
};
```
