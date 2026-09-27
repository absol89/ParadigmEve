# Public focus test: fresh install

Use this pass before handing a build to a new tester. The automated gate runs only ParadigmEve-owned code and local browser-management behavior. Provider pages stay manual by design.

## Automated gate

Run:

```powershell
npm run accept:fresh-install
```

The gate uses temporary test directories rather than the live `%APPDATA%\ParadigmEve` directory. It covers pristine config/secret defaults, the folder prerequisite, Setup rendering, the guided browser handoff and Companion liveness checks, tunnel/key capture ordering, connection admission/reconnect behavior, and restart/recovery selection.

## Manual focus-test checklist

Use a disposable Windows account/VM or another machine where ParadigmEve has never run. Do not delete a tester's existing AppData to manufacture a clean install.

- [ ] **Pristine launch:** before first launch, confirm `%APPDATA%\ParadigmEve` does not exist. Install and launch the build. Setup opens first, shows no shared folder, and Connect plus **Start guided browser setup** remain unavailable until a folder is chosen.
- [ ] **Folder:** choose a harmless test workspace. Confirm it appears as the approved folder and the guided-setup button becomes available. Do not grant a parent folder just to make the test easier.
- [ ] **Guided setup / dedicated profile:** click **Start guided browser setup**. Confirm ParadigmEve opens its dedicated Chrome profile and that the guide progresses through sign-in/Companion/tunnel/key/connector steps without replacing the tester's ordinary Chrome profile.
- [ ] **Companion:** follow the guide to `chrome://extensions`, load the included Companion, then open or reload a ChatGPT tab in the dedicated profile. The guide must refuse to advance until the live Companion checks in; an installed extension card alone is not enough.
- [ ] **Tunnel and key:** on the OpenAI pages, manually create the ParadigmEve tunnel in the same workspace as ChatGPT and copy its tunnel ID. Manually create a Restricted API key with only **Tunnels: Read** and **Tunnels: Use**. Paste values only into the local guide. The key must never reappear in the app UI or logs after capture.
- [ ] **Connect before connector creation:** after the key is captured, confirm ParadigmEve starts its local MCP service and reaches **Connected**. If secure OS credential storage is unavailable, setup must stop with a clear error instead of storing the key insecurely.
- [ ] **ChatGPT connector handoff:** follow the guide's manual ChatGPT steps: enable Developer mode, create the single ParadigmEve connector, use the exact local name/description/icon, choose **No authentication**, and select the tunnel created above. ParadigmEve must not click, type into, or scrape the provider page for the tester.
- [ ] **End-to-end verification:** from a fresh ChatGPT conversation created after the Companion was installed, call a low-risk ParadigmEve tool against the approved test folder. Setup should mark ChatGPT verified only after a real request/tool call reaches the required connector.
- [ ] **Relaunch:** fully quit ParadigmEve and launch it again. The approved folder and tunnel ID must still be present and the stored API key must be usable without being shown. Fresh-install `autoConnect` is off, so click **Connect** unless the tester explicitly enabled auto-connect. The live Companion must check in again; a surviving pairing token alone must not mark the browser step complete.
- [ ] **Recovery:** with an ordinary recorded ChatGPT turn that has unfinished local work, quit and relaunch ParadigmEve. Confirm the dedicated profile reopens the exact recoverable chat and the queued recovery instruction is not duplicated. If no eligible unfinished turn exists, relaunch must not invent one. Browser extension recovery may use ParadigmEve's own `chrome://extensions` management surface, but it must not automate ChatGPT/OpenAI pages.

Record the app version, Companion version, Windows version, ChatGPT plan/workspace, and the first failing checkbox when filing a focus-test report. Attach the ParadigmEve activity log with credentials redacted; never include the tunnel API key.
