# CI and provider tests (2.3.6)

From Eve's CI audit of `release/2.3.6`. CI (`npm run verify:ci` on Windows, macOS, Ubuntu) has no Ollama
daemon, no Ollama sign-in or pulled model, no ChatGPT account and no GPU. The deterministic suite must
stay runnable there.

## Done

- `test/ollama-chat-provider.test.ts` fails closed: only the test's own loopback bridge reaches the real
  network; any other unmocked host throws `unexpected network request`.
- The same test turns `desktopAutomationSupported` off, so the Ollama tool loop never depends on native
  Desktop tool registration of the CI host.
- The separate worker-cap test uses `fixture-local-model` and `fixture-model:cloud`.

## Follow-ups

- Generic routing, consent, credential and worker tests: prefer synthetic ids (`fixture-model:cloud`,
  `fixture-local-model`, `fixture-thinking-model`). Keep real names (`gemma4:cloud`, `gpt-5-6-thinking`, ...)
  only where the test is about compatibility with observed Ollama or ChatGPT metadata.
- Rename fixture-based descriptions that read as live, e.g. "fresh Plus account model discovery" →
  "Plus-account model-state fixture".
- Local vs cloud classification is proven through `remote_host`, the endpoint route and the `:cloud` suffix,
  never through a model happening to exist.
- One platform-specific test that the production local-chat surface includes Desktop tools where the OS
  supports them.
- Live provider tests only behind opt-in gates (`COS_PROVIDER_LIVE_TEST=1`, or narrower
  `COS_OLLAMA_LIVE_TEST=1` / `COS_CHATGPT_LIVE_TEST=1`), never in ordinary PR CI: real daemon and model,
  signed-in `:cloud` routing, direct `https://ollama.com/v1` key path, tool/vision support of a known model,
  the live ChatGPT picker, provider switching against a real ChatGPT browser.
- No GPU assertions in the normal suite.
