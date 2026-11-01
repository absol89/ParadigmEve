# Source file: `client/src/defaults.ts` at tag v3.2.1

- ID: LK-SRC-DEFAULTS
- Publisher: Larkspur project (official repository, file view at a release tag)

```ts
export const DEFAULTS = {
  retries: 5,
  retryBackoffMs: 250,
  maxPayloadBytes: 4 * 1024 * 1024,
  compression: false,
  legacyAuth: false, // deprecated since 3.1.0
};
```
