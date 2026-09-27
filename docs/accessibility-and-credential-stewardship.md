# Accessibility, browser identity, and credential stewardship

ParadigmEve should make powerful setup work accessible without weakening the security boundaries that protect the user.

This document records the intended product architecture for voice-assisted setup, browser identity, and the creation of tunnels or API credentials for ParadigmEve and other user-authorized applications. Some items below are design requirements for future implementation rather than claims about functionality that is already complete.

## Accessibility principle

A user who has difficulty typing, clicking, or navigating provider dashboards should be able to authorize Eve by voice and have Eve perform the ordinary setup steps on their behalf when the relevant Computer-use permissions have been granted.

For example, a user may say that Eve is allowed to create the tunnel and restricted API key needed by an application. Eve may then navigate the provider UI using normal desktop input, enter the requested configuration, capture the resulting credential locally, configure the application, and verify the connection.

Reducing physical interaction must not mean reducing security. Voice authorization can satisfy the user-interaction requirement for an assistive workflow, but ParadigmEve must still preserve provider safeguards, local permission checks, caller identity checks, credential isolation, and least privilege.

Eve must stop and return control to the user when a provider requires a human-only step that should not be automated, including CAPTCHAs or similar human-verification challenges. ParadigmEve must not attempt to bypass provider safety, anti-abuse, or account-protection mechanisms.

## Eve's dedicated browser identity

Eve should keep her own dedicated ParadigmEve Chrome profile and window running for her own ChatGPT and Companion identity.

That profile is the normal home for:

- Eve's signed-in ChatGPT session;
- the ParadigmEve Companion that proves which conversation made a request;
- ordinary OpenAI/ChatGPT setup pages used by Eve;
- extension management for Eve's own Companion; and
- fresh ChatGPT tabs opened after a Companion install or reload so the content script is definitely injected.

OpenAI and ChatGPT provider pages in this profile must remain ordinary Chrome. Do not use Playwright, a remote debugging port, `--enable-automation`, or equivalent browser-automation instrumentation for those pages.

Native Computer use may interact with Eve's own Chrome profile when useful. Self-interaction should avoid manipulating the exact ChatGPT page in the middle of executing the current Computer-use request unless necessary, because doing so introduces avoidable re-entrancy and attribution races. Provider setup tabs, extension management, and newly opened verification tabs are safer targets.

Extension installation metadata is not sufficient proof that Eve is connected. When the Companion is required, setup is healthy only after ParadigmEve receives an authenticated live Companion check-in from a ChatGPT page in that profile.

## Temporary cross-window coordination

For the current multi-computer development workflow, keep each ParadigmEve installation separated at
the browser-profile boundary. Each installation still has one human-facing agent, named by its own
configured connector name.

An agent keeps her own dedicated ParadigmEve Chrome profile and can use ParadigmEve Computer use to
interact with a separate persistent browser window when coordination across installations is needed.
This permits a temporary UI-driven coordination loop without allowing two Companion extensions to
inject into the same ChatGPT page or profile.

Conceptually:

```text
installation A Chrome -> Companion A -> ParadigmEve A
Computer use          -> installation B Chrome -> agent B conversation
```

This UI-driven bridge is intentionally transitional. A future authenticated agent-to-agent mailbox should carry messages directly, with explicit device identity, replay protection, conversation ownership, and a distinction between advice/messages and requests for local action. Remote messaging must not silently become unrestricted remote shell access.

## Credential stewardship

ParadigmEve is not limited to provisioning credentials for itself. With explicit user authorization, Eve may help create tunnels, API keys, or similar provider credentials needed by other applications that help the user.

The governing rule is credential isolation rather than a one-key-only restriction:

- ParadigmEve's own credentials stay dedicated to ParadigmEve.
- A different application should receive its own tunnel and its own key when the provider supports that model.
- Each credential should be granted only the permissions that application actually needs.
- Credentials should use clear application-specific labels so the user can identify and revoke them later.
- Revoking one application's credentials should not break unrelated applications.
- Broad or unusually powerful credentials require stronger user confirmation than narrowly scoped credentials.
- Non-secret metadata may be recorded locally for stewardship: owning application, provider, creation time, intended scopes, and revocation guidance.
- Secrets themselves must not be written to conversation history, prompts, URLs, logs, source files, Git, or ordinary configuration files.

For ParadigmEve's OpenAI tunnel connection, the normal key remains a **Restricted** key with only the required tunnel permissions, currently **Tunnels: Read** and **Tunnels: Use**. Granting Eve broad Computer-use authority does not imply that provider API credentials should be unrestricted.

## Secret-transfer boundary

When Eve creates a credential through an ordinary provider UI, the preferred path is direct local transfer into the destination application's secure credential store.

For ParadigmEve itself, the invariant remains:

```text
authorized setup action
  -> ordinary Chrome provider UI
  -> one-time credential capture
  -> Electron safeStorage / OS credential protection
  -> encrypted local secret storage
  -> clear transient input or clipboard material
  -> connect/test
```

The secret must not be spoken back unnecessarily, pasted into ChatGPT, exposed to renderer state, placed in a query string, or retained in clipboard history longer than needed. ParadigmEve's existing API-key storage rules remain authoritative: secrets belong in the encrypted `secrets.bin` path backed by Electron `safeStorage`, not `config.json`.

For another application, use that application's secure credential mechanism where available. If no secure destination exists, Eve should explain the limitation rather than silently falling back to an insecure storage location.

## Permission model

"Full permission to help me" means Eve may carry out the user's authorized setup work within the capabilities the user has enabled. It does not mean:

- bypassing `CALLER_IDENTITY_REQUIRED` or guessing the calling conversation;
- enabling "Allow unattributed calls" as a substitute for correct Companion identity;
- creating unrestricted provider keys when narrower scopes work;
- bypassing MFA, CAPTCHAs, anti-abuse controls, or provider policy;
- sharing one master credential across unrelated applications; or
- treating remote agent messages as blanket permission for arbitrary local execution.

Accessibility and security should reinforce each other: the user should need fewer physical interactions, while the resulting credentials and actions remain scoped, attributable, auditable, and revocable.
