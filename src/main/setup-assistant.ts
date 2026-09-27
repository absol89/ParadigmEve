import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from 'electron';
import { findPreferredBrowser, selectedChatBrowser, WINDOWS_UNTHROTTLED_CHAT_FLAGS } from './browser.js';
import { act, findUi, listWindows, type WindowInfo } from './computer/index.js';
import { extensionDir } from './extension-path.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import { chatBrowserFamily, chatBrowserForExtensionsUrl } from '../shared/chat-browser.js';
import { CHAT_BROWSERS, type ChatBrowser } from '../shared/types.js';

export type SetupAssistantStage =
  | 'idle'
  | 'starting'
  | 'chatgpt-signin'
  | 'extension'
  | 'openai-tunnel'
  | 'openai-api-key'
  | 'credentials'
  | 'chatgpt-plugins'
  | 'complete'
  | 'stopped'
  | 'error';

export interface SetupAssistantStartOptions {
  coreConnectorName: string;
  coreConnectorDescription: string;
  connectorIconPath: string;
  /** Browser family selected in Settings for this guided run. Chrome remains the legacy default. */
  browser?: ChatBrowser;
  /**
   * Startup work that must succeed before the local guide or dedicated Chrome process opens.
   *
   * IPC uses this for the Companion bridge. Keeping the await inside the setup run means Stop,
   * duplicate Start clicks and failures all share the same lifecycle owner instead of creating a
   * half-started bridge before setup itself exists.
   */
  preflight?: (signal: AbortSignal) => Promise<void>;
  /** True only after the authenticated Companion has actually checked in to this process. */
  companionPresent: () => boolean | Promise<boolean>;
  /**
   * Main-process handoff once both OpenAI values have been captured locally.
   *
   * The browser assistant never persists secrets itself. IPC owns encrypted storage and the
   * tunnel lifecycle, but doing that handoff here (before ChatGPT app creation) keeps the setup
   * dependency chain honest: ChatGPT is asked to select an already-live tunnel.
   */
  onCredentials?: (completion: Readonly<SetupAssistantCompletion>) => Promise<void>;
}

export interface SetupAssistantCompletion {
  tunnelId: string;
  apiKey: string;
}

export interface SetupAssistantSnapshot {
  stage: SetupAssistantStage;
  running: boolean;
  detail: string;
  error: string | null;
}

export class SetupAssistantStoppedError extends Error {
  constructor() {
    super('ParadigmEve setup was stopped.');
    this.name = 'SetupAssistantStoppedError';
  }
}

type Listener = (snapshot: SetupAssistantSnapshot) => void;
interface Run {
  chromeProcess: ChildProcess | null;
  browser: ChatBrowser;
  loginGuideServer: Server | null;
  cancelManualSignIn: ((error?: Error) => void) | null;
  abort: AbortController;
  closePromise: Promise<void> | null;
  stopping: boolean;
  completed: boolean;
}

const CHATGPT_URL = 'https://chatgpt.com/';
const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const API_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
const CHATGPT_DEVELOPER_MODE_URL = 'https://chatgpt.com/#settings/Security?section=developer-mode';
const CHATGPT_CREATE_CONNECTOR_URL = 'https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins';
const PARADIGMEVE_BROWSER_RESTART_URL: Readonly<Record<ChatBrowser, string>> = {
  chrome: 'chrome://restart/',
  edge: 'edge://restart/',
  brave: 'brave://restart/',
};
const RECOVERY_FOCUS_ATTEMPTS = 5;
const RECOVERY_FOCUS_RETRY_MS = 200;
const PARADIGMEVE_BROWSER_PROFILE: Readonly<Record<ChatBrowser, string>> = {
  // Keep the long-lived Chrome profile exactly where existing installations already own it.
  chrome: 'setup-browser-profile',
  edge: 'setup-browser-profile-edge',
  brave: 'setup-browser-profile-brave',
};
const PARADIGMEVE_BROWSER_PROCESS: Readonly<Record<ChatBrowser, string>> = {
  chrome: 'chrome',
  edge: 'msedge',
  brave: 'brave',
};
const PARADIGMEVE_BROWSER_PROFILE_APP_SUFFIX: Readonly<Record<ChatBrowser, string>> = {
  chrome: '.setupbrowserprofile.default',
  edge: '.setupbrowserprofileedge.default',
  brave: '.setupbrowserprofilebrave.default',
};
const PARADIGMEVE_BROWSER_PROCESS_PATH_SUFFIX: Readonly<Record<Exclude<ChatBrowser, 'chrome'>, string>> = {
  edge: '\\microsoft\\edge\\application\\msedge.exe',
  brave: '\\bravesoftware\\brave-browser\\application\\brave.exe',
};
const SETUP_LINKS = new Set([
  CHATGPT_URL,
  TUNNELS_URL,
  API_KEYS_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_CREATE_CONNECTOR_URL,
  ...CHAT_BROWSERS.map((browser) => chatBrowserFamily(browser).extensionsUrl),
]);
const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/;

let current: Run | null = null;
let restoreBrowserTask: Promise<void> | null = null;
let state: SetupAssistantSnapshot = {
  stage: 'idle',
  running: false,
  detail: 'ParadigmEve setup has not started.',
  error: null,
};
const listeners = new Set<Listener>();

function publish(next: SetupAssistantSnapshot): void {
  state = next;
  const copy = setupAssistantSnapshot();
  for (const listener of listeners) {
    try { listener({ ...copy }); } catch { /* A renderer notification cannot own setup lifetime. */ }
  }
}

function update(stage: SetupAssistantStage, detail: string, error: string | null = null): void {
  publish({ stage, running: current !== null && !current.stopping, detail, error });
}

function requireActiveRun(run: Run): void {
  if (run.stopping || current !== run || run.abort.signal.aborted) throw new SetupAssistantStoppedError();
}

function setupErrorMessage(error: unknown, sensitiveValues: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : 'ParadigmEve setup failed.';
  for (const value of sensitiveValues) {
    if (!value) continue;
    message = message.split(value).join('[redacted]');
  }
  return message;
}

export function setupAssistantSnapshot(): SetupAssistantSnapshot {
  return { ...state };
}

export function onSetupAssistantChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

const GUIDE_EMBLEM = `<svg class="emblem" data-paradigmeve-art="goddess-emblem" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="20" r="14"></circle><path d="M25 17c2-5 5-8 7-8s5 3 7 8M21 48c3-13 8-20 11-20s8 7 11 20M17 53c7-5 12-7 15-7s8 2 15 7"></path><path class="soft" d="M14 18c6 2 10 8 10 15s-4 13-10 15M50 18c-6 2-10 8-10 15s4 13 10 15"></path></svg>`;

interface ManualProviderGuide {
  url: string;
  waitForCompletion: Promise<SetupAssistantCompletion>;
}

function manualProviderDocument(options: SetupAssistantStartOptions, extension: string, actionPath: string): string {
  const browser = chatBrowserFamily(options.browser);
  const browserLabel = escapeHtml(browser.label);
  const extensionsUrl = escapeHtml(browser.extensionsUrl);
  const urls = {
    chatgpt: JSON.stringify(CHATGPT_URL),
    tunnels: JSON.stringify(TUNNELS_URL),
    apiKeys: JSON.stringify(API_KEYS_URL),
    developerMode: JSON.stringify(CHATGPT_DEVELOPER_MODE_URL),
    createConnector: JSON.stringify(CHATGPT_CREATE_CONNECTOR_URL),
  };
  const name = escapeHtml(options.coreConnectorName);
  const description = escapeHtml(options.coreConnectorDescription);
  const connectorIconFolder = escapeHtml(path.dirname(options.connectorIconPath));
  const extensionPath = escapeHtml(extension);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'"><title>ParadigmEve · Guided setup</title>
<style>
:root{color-scheme:dark;--navy:#07111f;--navy2:#0c2035;--gold:#e6c673;--gold2:#f4dda1;--text:#f8f4e8;--muted:#9fb0c4;--line:rgba(230,198,115,.22);--good:#91d7a8;--bad:#e5aab0}*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{display:grid;place-items:center;padding:30px;font:16px/1.58 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:radial-gradient(circle at 50% 0,rgba(230,198,115,.14),transparent 34%),linear-gradient(145deg,#050c17,#07111f 48%,#0a1a2c)}main{width:min(1040px,100%);border:1px solid var(--line);border-radius:26px;padding:clamp(24px,4.5vw,48px);background:linear-gradient(155deg,rgba(18,42,69,.94),rgba(7,17,31,.97));box-shadow:0 28px 80px rgba(0,0,0,.4)}.brand{display:flex;align-items:center;gap:14px;color:var(--gold2);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.emblem{width:58px;height:58px;filter:drop-shadow(0 0 18px rgba(230,198,115,.18))}.emblem circle,.emblem path{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}.emblem .soft{opacity:.45;stroke-width:1}.journey{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:24px 0 12px}.journey button{min-height:64px;padding:10px 9px;border:1px solid rgba(159,176,196,.18);border-radius:12px;background:rgba(5,12,23,.42);color:#9fb0c4;text-align:left}.journey button:hover{border-color:rgba(230,198,115,.42);color:#e8edf3}.journey button.active{border-color:var(--gold);background:linear-gradient(180deg,rgba(230,198,115,.14),rgba(5,12,23,.58));color:#fff4d0;box-shadow:inset 0 0 0 1px rgba(230,198,115,.08)}.journey button.done .stepnum{background:#8bcf9f;border-color:#8bcf9f;color:#082013}.stepnum{display:grid;place-items:center;width:24px;height:24px;border:1px solid #536a81;border-radius:50%;margin-bottom:6px;font-size:12px}.stepname{display:block;font-size:11px;line-height:1.2;letter-spacing:.02em}.guidehint,.ownership{border:1px solid rgba(230,198,115,.14);border-radius:13px;background:rgba(5,12,23,.42);color:#aebdcd;font-size:12px;padding:11px 13px}.ownership{margin-top:9px}.ownership strong{color:#f3dfac}.previewnotice{margin:16px 0 0;border-left:3px solid var(--gold);border-radius:9px;background:rgba(230,198,115,.08);padding:10px 13px;color:#e9dfc3;font-size:13px}.phase{display:none}.phase.active{display:block}.phase.preview .actions,.phase.preview .fields,.phase.preview .launch,.phase.preview .copybtn{opacity:.48}.step{margin-top:24px;color:var(--gold);font-size:12px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}h1{font:500 clamp(34px,6vw,54px)/1.05 Georgia,"Times New Roman",serif;margin:8px 0 22px;color:#fffaf0}.copy{max-width:78ch;color:#d8e0ea}.copy strong{color:#fff5db}.copy code{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;color:#f7e7b5;background:#07111f;border:1px solid rgba(230,198,115,.18);border-radius:7px;padding:2px 6px}.substeps{display:grid;gap:14px;margin:24px 0}.substep{border:1px solid rgba(230,198,115,.14);background:rgba(5,12,23,.46);border-radius:16px;padding:17px 18px}.substep>b{display:block;color:var(--gold2);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:5px}.launch{display:inline-flex;align-items:center;justify-content:center;margin-top:14px}.copyrow{display:grid;grid-template-columns:1fr auto;gap:9px;margin:10px 0}.copyvalue{white-space:pre-wrap;overflow-wrap:anywhere;background:#07111f;border:1px solid rgba(230,198,115,.18);border-radius:10px;padding:11px 13px;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:#f7e7b5}.fields{margin-top:15px}.fields label{display:block;font-size:13px;font-weight:700}.secretrow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;margin-top:7px}.fields input{display:block;width:100%;min-height:48px;border:1px solid #39526d;border-radius:12px;background:#07111f;color:#fff;padding:12px 14px;font:15px ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}.fields input:focus{border-color:var(--gold)}.eyebtn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:86px;border:1px solid #4b6076;background:#10253d;color:#e7edf5}.eyeicon{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.safetyline{margin-top:9px;color:#a7b5c4;font-size:12px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px;padding-top:24px;border-top:1px solid var(--line)}button{min-height:48px;padding:0 18px;border-radius:13px;font:750 14px/1.2 inherit;cursor:pointer}button:disabled{cursor:not-allowed;filter:saturate(.55);opacity:.52}.yes{border:1px solid var(--gold2);background:linear-gradient(180deg,#f2d98e,#d5ae50);color:#172132}.secondary{border:1px solid #48627d;background:#10253d;color:#e7edf5}.copybtn{border:1px solid #665a3b;background:#171c20;color:var(--gold2);min-height:44px}.no{border:1px solid #445a70;background:transparent;color:#bdc9d5}.status{min-height:20px;margin-top:14px;color:var(--muted);font-size:13px}.status.good{color:var(--good)}.status.bad{color:var(--bad)}.privacy{margin-top:24px;color:#8193a5;font-size:11px}@media(max-width:820px){.journey{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:700px){body{padding:14px}.copyrow,.secretrow{grid-template-columns:1fr}.journey{grid-template-columns:repeat(2,minmax(0,1fr))}.eyebtn{min-width:0}}
</style></head><body><main><div class="brand">${GUIDE_EMBLEM}<span>ParadigmEve · guided revelation</span></div>
<nav class="journey" aria-label="Setup steps"><button type="button" data-guide-step="1"><span class="stepnum">1</span><span class="stepname">ChatGPT</span></button><button type="button" data-guide-step="2"><span class="stepnum">2</span><span class="stepname">Companion</span></button><button type="button" data-guide-step="3"><span class="stepnum">3</span><span class="stepname">Tunnel</span></button><button type="button" data-guide-step="4"><span class="stepnum">4</span><span class="stepname">API key</span></button><button type="button" data-guide-step="5"><span class="stepnum">5</span><span class="stepname">Connection</span></button><button type="button" data-guide-step="6"><span class="stepnum">6</span><span class="stepname">ChatGPT app</span></button></nav>
<div class="guidehint">You can click steps 1–6 at any time to preview what comes next or revisit an earlier step. Future-step controls stay locked until the required earlier actions are complete.</div><div class="ownership"><strong>Recording or livestreaming?</strong> Tunnel ID and API key stay masked by default and re-mask when you change steps. Reveal them only when you need to check them. This ${browserLabel} guide collects setup values; the ParadigmEve app owns encrypted credential storage and local permission enforcement.</div><div class="previewnotice" id="previewNotice" hidden>Preview only — finish the earlier setup steps before using the controls on this page.</div>
<section class="phase active" id="phase1"><div class="step">Step 1 / 6 · ChatGPT</div><h1>Keep the conversation. Lose the busywork.</h1><div class="copy"><p>ParadigmEve lets you keep using <strong>ChatGPT the way you already prefer</strong> — typing, dictating or speaking naturally — while giving that conversation a little more ability to help on this PC.</p><p>Instead of constantly copying text between apps, switching windows, finding files or turning every request into computer instructions yourself, ChatGPT can take on more of those steps for you. Longer tasks can keep working while this PC is on, and the same approach can be especially helpful if typing or precise navigation is difficult.</p><p>This setup uses a <strong>dedicated ParadigmEve ${browserLabel} profile</strong>. Your normal ${browserLabel} profile is not modified. <strong>No provider page opens until you choose YES.</strong></p></div><div class="actions"><button class="yes" id="start">YES — Connect ChatGPT</button><button class="no stop">NO — Stop setup</button></div></section>
<section class="phase" id="phase2"><div class="step">Step 1 / 6 · ChatGPT</div><h1>Sign in normally</h1><div class="copy"><p>Complete ChatGPT sign-in in the other tab. When your account is fully loaded, return here.</p></div><div class="actions"><button class="yes" id="signedIn">I’M SIGNED IN — Continue</button><button class="no stop">NO — Stop setup</button></div><div class="status">No browser automation is active.</div></section>
<section class="phase" id="phase3"><div class="step">Step 2 / 6 · Companion</div><h1>Add the ParadigmEve Companion</h1><div class="copy"><p>The Companion is what gives stateful Computer use and agent/session features exact proof of <strong>which ChatGPT conversation made a request</strong>. Loading the extension card is not enough: ParadigmEve verifies a live authenticated check-in before setup can continue.</p><div class="substeps"><div class="substep"><b>1 / 4 · Open extensions</b>Open the Extensions page in the <strong>same dedicated ParadigmEve ${browserLabel} profile</strong> this setup is already using.<div><button class="yes launch" id="openBrowserExtensions">OPEN EXTENSIONS PAGE</button></div><div class="copyrow"><div class="copyvalue" id="extensionsUrl">${extensionsUrl}</div><button class="copybtn" data-copy="extensionsUrl">Copy address instead</button></div></div><div class="substep"><b>2 / 4 · Load unpacked</b>Turn on <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and select this exact folder:<div class="copyrow"><div class="copyvalue" id="extensionPath">${extensionPath}</div><button class="copybtn" data-copy="extensionPath">Copy folder</button></div></div><div class="substep"><b>3 / 4 · Open a fresh ChatGPT tab</b>After the extension appears, open a <strong>fresh ChatGPT tab</strong> in this same profile so the Companion is injected into a page created after installation.<div><button class="yes launch" id="openFreshChatgpt">OPEN FRESH CHATGPT TAB</button></div></div><div class="substep"><b>4 / 4 · Verify the live connection</b>Wait for ChatGPT to finish loading, then verify. ParadigmEve will only continue after it has actually heard from the authenticated Companion.</div></div></div><div class="actions"><button class="yes" id="companionDone">VERIFY COMPANION — Continue</button><button class="no stop">NO — Stop setup</button></div><div class="status" id="companionStatus"></div></section>
<section class="phase" id="phase4"><div class="step">Step 3 / 6 · Tunnel</div><h1>Create a tunnel</h1><div class="copy"><div class="substeps"><div class="substep"><b>1 / 3 · Create Tunnel</b>Click the button below. On the OpenAI page that opens, click <strong>Create Tunnel</strong> on the right side of the screen.<div><button class="yes launch" id="openTunnels">OPEN OPENAI TUNNELS</button></div></div><div class="substep"><b>2 / 3 · Add the details</b>Name it <strong>${name}</strong>, choose the organization and ChatGPT workspace you want to use, then paste this description:<div class="copyrow"><div class="copyvalue" id="tunnelDescription">${description}</div><button class="copybtn" data-copy="tunnelDescription">Copy description</button></div></div><div class="substep"><b>3 / 3 · Copy Tunnel ID</b>Click <strong>Create</strong>. When the tunnel has been created, copy its <strong>Tunnel ID</strong> and paste it here.<div class="fields"><label for="tunnelId">Tunnel ID</label><div class="secretrow"><input id="tunnelId" type="password" data-secret-label="Tunnel ID" autocomplete="off" spellcheck="false" placeholder="tunnel_0123456789abcdef0123456789abcdef"><button type="button" class="eyebtn" data-secret-toggle="tunnelId" aria-label="Show Tunnel ID" aria-pressed="false"><svg class="eyeicon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.7"></circle></svg><span class="toggleLabel">Show</span></button><button type="button" class="copybtn" data-copy-input="tunnelId">Copy</button></div><div class="safetyline">Masked by default for screen recordings and livestreams. Use the eye only when you need to verify the value.</div></div></div></div></div><div class="actions"><button class="yes" id="saveTunnel">SAVE TUNNEL ID — Continue</button><button class="no stop">NO — Stop setup</button></div><div class="status" id="tunnelStatus"></div></section>
<section class="phase" id="phase5"><div class="step">Step 4 / 6 · API key</div><h1>Create an API key</h1><div class="copy"><div class="substeps"><div class="substep"><b>1 / 3 · Open</b>Go to this API keys page and click <strong>+ Create New Secret Key</strong>. Choose any relevant or default project.<div><button class="yes launch" id="openApiKeys">OPEN OPENAI API KEYS</button></div></div><div class="substep"><b>2 / 3 · Restrict it</b>Name it <strong>ParadigmEve</strong>, choose <strong>Restricted</strong>, then allow only <strong>Tunnels: Read</strong> and <strong>Tunnels: Use</strong>. Leave unrelated permissions on <strong>None</strong>. Computer use is part of this same ParadigmEve connection, so there is no second tunnel or API key.</div><div class="substep"><b>3 / 3 · Copy API key</b>Create the key, copy it when OpenAI shows it, and paste it here immediately. OpenAI only shows this secret once. ParadigmEve keeps this field masked while you enter it, then clears the field after the app securely stores the key.<div class="fields"><label for="apiKey">API key</label><div class="secretrow"><input id="apiKey" type="password" data-secret-label="API key" autocomplete="off" spellcheck="false" placeholder="sk-…"><button type="button" class="eyebtn" data-secret-toggle="apiKey" aria-label="Show API key" aria-pressed="false"><svg class="eyeicon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.7"></circle></svg><span class="toggleLabel">Show</span></button><button type="button" class="copybtn" data-copy-input="apiKey">Copy</button></div><div class="safetyline">Masked by default. Hide it again before recording, streaming, screen sharing, or handing the browser to someone else.</div></div></div></div></div><div class="actions"><button class="yes" id="saveApiKey">SAVE API KEY — Continue</button><button class="no stop">NO — Stop setup</button></div><div class="status" id="apiStatus"></div></section>
<section class="phase" id="phase6"><div class="step">Step 5 / 6 · Connection</div><h1>Your connection is ready</h1><div class="copy"><p>ParadigmEve has securely saved the Tunnel ID and API key in the app’s encrypted credential store. The API key field in this guide is now cleared; the stored key is never read back into the page. The Tunnel ID remains masked if you revisit its step.</p><p>Next, enable ChatGPT <strong>Developer mode</strong>, then create the ${name} connector.</p></div><div class="actions"><button class="yes" id="openDeveloperMode">YES — Open Developer mode</button><button class="no stop">NO — Stop setup</button></div></section>
<section class="phase" id="phase7"><div class="step">Step 6 / 6 · ChatGPT app</div><h1>Add ${name} to ChatGPT</h1><div class="copy"><div class="substeps"><div class="substep"><b>1 / 6 · Turn on Developer mode</b>Open ChatGPT Developer mode and turn it <strong>On</strong>. Developer mode enables the custom ${name} connector; it does <strong>not</strong> grant unrestricted action access by itself.<div><button class="yes launch" id="openDeveloperModeAgain">OPEN DEVELOPER MODE</button></div></div><div class="substep"><b>2 / 6 · Create connector</b>Open the connector creation page. ChatGPT should take you directly to the form for adding a connector.<div><button class="yes launch" id="openCreateConnector">OPEN CREATE CONNECTOR</button></div></div><div class="substep"><b>3 / 6 · Paste the details</b>Use these exact values here so ParadigmEve can recognize the app later.<div class="copyrow"><div class="copyvalue" id="appName">${name}</div><button class="copybtn" data-copy="appName">Copy app name</button></div><div class="copyrow"><div class="copyvalue" id="appDescription">${description}</div><button class="copybtn" data-copy="appDescription">Copy description</button></div></div><div class="substep"><b>4 / 6 · Upload the icon</b>When ChatGPT asks for an app icon, open this folder and choose the included <strong>icon.png</strong> or another icon you placed there:<div class="copyrow"><div class="copyvalue" id="connectorIconPath">${connectorIconFolder}</div><button class="copybtn" data-copy="connectorIconPath">Copy icon folder</button></div></div><div class="substep"><b>5 / 6 · No auth + Tunnel</b>For authentication choose <strong>No authentication</strong>. For the connection choose <strong>Tunnel</strong>, select the <strong>${name}</strong> tunnel you created in Step 3, and save the connector.</div><div class="substep"><b>6 / 6 · Choose how much autonomy you want</b>After saving, open <strong>Settings → Plugins → ${name} → Permissions</strong>. We recommend leaving <strong>Allow low risk actions</strong> selected. ChatGPT can automatically approve actions it considers low risk, while higher-risk actions such as commands, file changes, or computer-control actions may ask for your approval or be denied. Choose <strong>Allow all actions</strong> only if you intentionally want longer Goal, Loop, or agent tasks to keep working without those approval stops. ParadigmEve’s own folder and capability permissions still apply either way.</div></div></div><div class="actions"><button class="yes" id="coreDone">APP SAVED — Continue</button><button class="no stop">NO — Stop setup</button></div><div class="status" id="coreStatus"></div></section>
<section class="phase" id="phase8"><div class="step">App saved</div><h1>Verify one tool call</h1><div class="copy"><p>The tunnel, API key, ChatGPT app and Companion are configured. Return to a fresh ChatGPT conversation and ask it to run one low-risk ${name} tool. ParadigmEve marks first-run setup complete only after that recognized tool call reaches the required app.</p><p>You do not need to enable Computer use or <strong>Allow all actions</strong> for this verification.</p></div><div class="status good">You can return to the ParadigmEve app while you verify.</div></section>
<div class="privacy">Dedicated ParadigmEve ${browserLabel} profile · provider pages remain ordinary ${browserLabel} · local secrets are stored by the ParadigmEve app</div></main>
<script>
const actionPath=${JSON.stringify(actionPath)};const phaseStep={1:1,2:1,3:2,4:3,5:4,6:5,7:6,8:6};let started=false,unlockedStep=1;const phaseForStep=step=>step===1?(started?2:1):({2:3,3:4,4:5,5:6,6:7})[step];const maskSecrets=()=>{for(const input of document.querySelectorAll('[data-secret-label]'))input.type='password';for(const button of document.querySelectorAll('[data-secret-toggle]')){button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','Show '+document.getElementById(button.dataset.secretToggle).dataset.secretLabel);button.querySelector('.toggleLabel').textContent='Show'}};const show=n=>{maskSecrets();for(let i=1;i<=8;i++)document.getElementById('phase'+i).classList.toggle('active',i===n);const step=phaseStep[n]||1;const locked=step>unlockedStep;const phase=document.getElementById('phase'+n);phase.classList.toggle('preview',locked);for(const control of phase.querySelectorAll('button:not(.stop),input'))control.disabled=locked;const preview=document.getElementById('previewNotice');preview.hidden=!locked;for(const button of document.querySelectorAll('[data-guide-step]')){const buttonStep=Number(button.dataset.guideStep);button.classList.toggle('active',buttonStep===step);button.classList.toggle('done',buttonStep<unlockedStep);if(buttonStep===step)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current')}};const unlock=step=>{unlockedStep=Math.max(unlockedStep,step)};const task=url=>window.open(url,'paradigmeve-task');
const post=async payload=>{const response=await fetch(actionPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json().catch(()=>({}));if(!response.ok||data.ok===false)throw new Error(data.error||'ParadigmEve could not continue this step.');return data};
const setStatus=(id,text,kind='')=>{const node=document.getElementById(id);node.textContent=text;node.className='status '+kind};const copyText=async text=>{try{await navigator.clipboard.writeText(text);return true}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();return ok}};
for(const button of document.querySelectorAll('[data-copy]'))button.addEventListener('click',async()=>{const original=button.textContent;const source=document.getElementById(button.dataset.copy);button.textContent=await copyText(source.textContent||'')?'Copied ✓':'Select and copy';setTimeout(()=>button.textContent=original,1400)});
for(const button of document.querySelectorAll('[data-copy-input]'))button.addEventListener('click',async()=>{const original=button.textContent;const source=document.getElementById(button.dataset.copyInput);button.textContent=await copyText(source.value||'')?'Copied ✓':'Select and copy';setTimeout(()=>button.textContent=original,1400)});for(const button of document.querySelectorAll('[data-secret-toggle]'))button.addEventListener('click',()=>{const input=document.getElementById(button.dataset.secretToggle);const revealing=input.type==='password';input.type=revealing?'text':'password';button.setAttribute('aria-pressed',String(revealing));button.setAttribute('aria-label',(revealing?'Hide ':'Show ')+input.dataset.secretLabel);button.querySelector('.toggleLabel').textContent=revealing?'Hide':'Show'});for(const button of document.querySelectorAll('[data-guide-step]'))button.addEventListener('click',()=>show(phaseForStep(Number(button.dataset.guideStep))));
document.getElementById('start').addEventListener('click',async()=>{task(${urls.chatgpt});await post({action:'start'});started=true;show(2)});document.getElementById('signedIn').addEventListener('click',async()=>{await post({action:'signed-in'});unlock(2);show(3)});document.getElementById('openBrowserExtensions').addEventListener('click',async()=>{try{await post({action:'open-extensions'});setStatus('companionStatus','Opened the extensions page in the dedicated ParadigmEve browser profile.','good')}catch(error){setStatus('companionStatus',error.message,'bad')}});document.getElementById('openFreshChatgpt').addEventListener('click',async()=>{try{await post({action:'open-chatgpt-after-companion'});setStatus('companionStatus','Fresh ChatGPT tab opened. Wait for it to finish loading, then verify.','good')}catch(error){setStatus('companionStatus',error.message,'bad')}});document.getElementById('companionDone').addEventListener('click',async()=>{try{setStatus('companionStatus','Checking for the authenticated Companion…');await post({action:'companion-done'});setStatus('companionStatus','Companion connected.','good');unlock(3);show(4)}catch(error){setStatus('companionStatus',error.message,'bad')}});document.getElementById('openTunnels').addEventListener('click',()=>task(${urls.tunnels}));
document.getElementById('saveTunnel').addEventListener('click',async()=>{try{setStatus('tunnelStatus','Checking the Tunnel ID…');await post({action:'tunnel-id',tunnelId:document.getElementById('tunnelId').value});setStatus('tunnelStatus','Tunnel ID saved.','good');unlock(4);show(5)}catch(error){setStatus('tunnelStatus',error.message,'bad')}});document.getElementById('openApiKeys').addEventListener('click',()=>task(${urls.apiKeys}));
document.getElementById('saveApiKey').addEventListener('click',async()=>{const input=document.getElementById('apiKey');try{setStatus('apiStatus','Saving the key and starting ParadigmEve…');await post({action:'api-key',apiKey:input.value});input.value='';unlock(5);show(6)}catch(error){input.value='';setStatus('apiStatus',error.message,'bad')}});document.getElementById('openDeveloperMode').addEventListener('click',async()=>{task(${urls.developerMode});await post({action:'core-app-start'});unlock(6);show(7)});document.getElementById('openDeveloperModeAgain').addEventListener('click',()=>task(${urls.developerMode}));document.getElementById('openCreateConnector').addEventListener('click',()=>task(${urls.createConnector}));document.getElementById('coreDone').addEventListener('click',async()=>{try{await post({action:'core-app-done'});show(8)}catch(error){setStatus('coreStatus',error.message,'bad')}});for(const button of document.querySelectorAll('.stop'))button.addEventListener('click',()=>post({action:'stop'}).catch(()=>{}));show(1);
</script></body></html>`;
}

async function readGuideAction(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new Error('Setup action was too large.');
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid setup action.');
  return parsed as Record<string, unknown>;
}

function sendGuideJson(response: import('node:http').ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

async function startManualProviderGuide(run: Run, options: SetupAssistantStartOptions, extension: string): Promise<ManualProviderGuide> {
  let resolveCompletion!: (completion: SetupAssistantCompletion) => void;
  let rejectCompletion!: (error: Error) => void;
  const waitForCompletion = new Promise<SetupAssistantCompletion>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Stop or a launch failure can reject this before startManualProviderGuide has returned it to
  // startSetupAssistant. Mark that early rejection handled while preserving the same rejected
  // promise for the eventual await.
  void waitForCompletion.catch(() => undefined);
  run.cancelManualSignIn = (error) => rejectCompletion(error ?? new SetupAssistantStoppedError());

  const nonce = randomBytes(16).toString('hex');
  const actionPath = `/action/${nonce}`;
  const welcomePath = `/welcome/${nonce}`;
  const html = manualProviderDocument(options, extension, actionPath);
  let tunnelId = '';
  let completion: SetupAssistantCompletion | null = null;
  let started = false;
  let signedIn = false;
  let companionVerified = false;
  let coreAppStarted = false;
  let actionInFlight: string | null = null;

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && requestUrl.pathname === actionPath) {
      void (async () => {
        let claimedAction: string | null = null;
        const sensitiveValues = tunnelId ? [tunnelId] : [];
        try {
          const address = server.address() as AddressInfo;
          const expectedHost = `127.0.0.1:${address.port}`;
          if (request.headers.host !== expectedHost || request.headers.origin !== `http://${expectedHost}`) {
            sendGuideJson(response, 403, { ok: false, error: 'Rejected non-local setup action.' });
            return;
          }
          const payload = await readGuideAction(request);
          for (const field of ['tunnelId', 'apiKey'] as const) {
            const value = payload[field];
            if (typeof value === 'string' && value.length > 0) sensitiveValues.push(value);
          }
          const action = typeof payload.action === 'string' ? payload.action : '';
          if (action === 'stop') {
            run.stopping = true;
          } else {
            requireActiveRun(run);
            if (actionInFlight) {
              sendGuideJson(response, 409, { ok: false, error: 'Another Guided setup step is still finishing. Wait for it to complete, then try again.' });
              return;
            }
            actionInFlight = action;
            claimedAction = action;
          }
          if (action === 'start') {
            started = true;
            update('chatgpt-signin', 'Sign in to ChatGPT in your dedicated Eve Browser, then return to the guide.');
          } else if (action === 'signed-in') {
            if (!started) {
              sendGuideJson(response, 409, { ok: false, error: 'Choose Connect ChatGPT before confirming sign-in.' });
              return;
            }
            signedIn = true;
            update('extension', 'Load the ParadigmEve Companion in this dedicated Eve Browser profile before creating the connector.');
          } else if (action === 'open-extensions') {
            if (!signedIn) {
              sendGuideJson(response, 409, { ok: false, error: 'Sign in to ChatGPT before opening the Companion setup.' });
              return;
            }
            await openSetupAssistantLink(chatBrowserFamily(run.browser).extensionsUrl);
            requireActiveRun(run);
            update('extension', 'The extensions page opened in the same dedicated Eve Browser profile. Load the Companion folder there.');
          } else if (action === 'open-chatgpt-after-companion') {
            if (!signedIn) {
              sendGuideJson(response, 409, { ok: false, error: 'Sign in to ChatGPT before opening the post-install verification tab.' });
              return;
            }
            await openSetupAssistantLink(CHATGPT_URL);
            requireActiveRun(run);
            update('extension', 'Fresh ChatGPT tab opened after Companion installation. Wait for it to load, then verify the live connection.');
          } else if (action === 'companion-done') {
            if (!signedIn) {
              sendGuideJson(response, 409, { ok: false, error: 'Sign in to ChatGPT before verifying the Companion.' });
              return;
            }
            const companionPresent = await options.companionPresent();
            requireActiveRun(run);
            if (!companionPresent) {
              sendGuideJson(response, 409, { ok: false, error: 'ParadigmEve has not heard from the Companion yet. After loading it, open a fresh ChatGPT tab, wait for it to load, then try Verify again.' });
              return;
            }
            companionVerified = true;
            update('openai-tunnel', `Companion connected. Create the ${options.coreConnectorName} tunnel in Eve Browser, then paste its Tunnel ID into the guide.`);
          } else if (action === 'tunnel-id') {
            if (!companionVerified) {
              sendGuideJson(response, 409, { ok: false, error: 'Verify the Companion connection before creating the tunnel.' });
              return;
            }
            const candidate = typeof payload.tunnelId === 'string' ? payload.tunnelId.trim() : '';
            if (!TUNNEL_ID_PATTERN.test(candidate)) {
              sendGuideJson(response, 400, { ok: false, error: 'Invalid tunnel ID. Expected tunnel_ followed by 32 lowercase hexadecimal characters.' });
              return;
            }
            tunnelId = candidate;
            update('openai-api-key', 'Create the restricted tunnel API key in Eve Browser and paste it into the guide immediately.');
          } else if (action === 'api-key') {
            if (!tunnelId) {
              sendGuideJson(response, 409, { ok: false, error: 'Save the Tunnel ID before the API key.' });
              return;
            }
            const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
            if (!API_KEY_PATTERN.test(apiKey) || apiKey.length > 500) {
              sendGuideJson(response, 400, { ok: false, error: 'Invalid API key. Paste the restricted OpenAI key shown by the platform.' });
              return;
            }
            const candidateCompletion = { tunnelId, apiKey };
            update('credentials', 'Saving the connection credentials and starting ParadigmEve.');
            await options.onCredentials?.(candidateCompletion);
            requireActiveRun(run);
            completion = candidateCompletion;
            update('credentials', 'The connection is ready. Create the ChatGPT app in Eve Browser using the supplied details.');
          } else if (action === 'core-app-start') {
            if (!completion) {
              sendGuideJson(response, 409, { ok: false, error: 'Save the tunnel and API key before creating the ChatGPT app.' });
              return;
            }
            coreAppStarted = true;
            update('chatgpt-plugins', `Create the ${options.coreConnectorName} app in Eve Browser with the exact supplied name and description.`);
          } else if (action === 'core-app-done') {
            if (!completion) {
              sendGuideJson(response, 409, { ok: false, error: 'The connection is not ready yet.' });
              return;
            }
            if (!coreAppStarted) {
              sendGuideJson(response, 409, { ok: false, error: 'Open Developer mode before confirming the ChatGPT app is saved.' });
              return;
            }
            sendGuideJson(response, 200, { ok: true });
            run.cancelManualSignIn = null;
            resolveCompletion(completion);
            return;
          } else if (action === 'stop') {
            sendGuideJson(response, 200, { ok: true });
            run.cancelManualSignIn = null;
            rejectCompletion(new SetupAssistantStoppedError());
            return;
          } else {
            sendGuideJson(response, 400, { ok: false, error: 'Unknown setup action.' });
            return;
          }
          sendGuideJson(response, 200, { ok: true });
        } catch (error) {
          const message = setupErrorMessage(error, sensitiveValues);
          if (error instanceof SetupAssistantStoppedError || run.stopping || current !== run) {
            sendGuideJson(response, 409, { ok: false, error: 'ParadigmEve setup was stopped.' });
          } else {
            // A guide action is user-retryable. Keep the local guide and its already completed
            // steps alive, while also projecting the failure into the app so it survives a panel
            // repaint instead of existing only as transient browser text.
            update('error', message, message);
            sendGuideJson(response, 500, { ok: false, error: message });
          }
        } finally {
          if (claimedAction !== null && actionInFlight === claimedAction) actionInFlight = null;
        }
      })();
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === welcomePath) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'",
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end();
  });
  run.loginGuideServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', signal: run.abort.signal }, () => resolve());
  });
  requireActiveRun(run);
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}${welcomePath}`, waitForCompletion };
}

async function waitForProcessExit(process: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    process.once('exit', finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function waitForChromeSpawn(process: ChildProcess, browserLabel = 'Eve Browser'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      process.removeListener('spawn', onSpawn);
      process.removeListener('error', onError);
      process.removeListener('exit', onExit);
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`The dedicated ParadigmEve ${browserLabel} process exited before its setup window opened${code === null ? '.' : ` (exit ${code}).`}`));
    };
    process.once('spawn', onSpawn);
    process.once('error', onError);
    process.once('exit', onExit);
  });
}

async function stopLoginChrome(run: Run): Promise<void> {
  const chromeProcess = run.chromeProcess;
  if (!chromeProcess) return;
  // Authentication is already complete at this point. Give Chrome a moment to flush the
  // just-created cookies to ParadigmEve's private profile, then close only that owned process.
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (!chromeProcess.killed && chromeProcess.exitCode === null && chromeProcess.signalCode === null) {
    try { chromeProcess.kill(); } catch { /* Dedicated sign-in Chrome may already have exited. */ }
  }
  await waitForProcessExit(chromeProcess);
  run.chromeProcess = null;
}

/**
 * Open an onboarding destination in ParadigmEve's own Chrome profile.
 *
 * These links must never fall through to Electron's shell.openExternal(), because that hands
 * them to the user's default browser/profile and breaks the authenticated setup continuity.
 * Provider pages always stay in ordinary Chrome; this function never attaches Playwright or a
 * debugging port, including while guided setup is active.
 */
export async function openSetupAssistantLink(url: string): Promise<void> {
  if (!SETUP_LINKS.has(url)) throw new Error('That ParadigmEve setup link is not allowed.');

  const extensionBrowser = chatBrowserForExtensionsUrl(url);
  // Chromium-family browsers do not reliably route their internal extension URL through a
  // second-process command-line handoff.
  // handoff. On Windows that produced exactly the failure this setup must avoid: a fresh blank
  // Chrome window, while the authenticated ParadigmEve setup tabs remained in the existing one.
  // The user clicked this action inside the owned setup browser, so target that exact browser
  // process/window and use Chrome's omnibox shortcut to open the internal page as a new tab.
  if (extensionBrowser) {
    const run = current;
    const pid = run?.chromeProcess?.pid;
    if (!run || !pid) {
      throw new Error('Start Guided setup first so ParadigmEve can open Extensions in its existing Eve Browser window.');
    }
    if (extensionBrowser !== run.browser) throw new Error('That extensions page does not match the browser selected for this Guided setup run.');
    const windows = (await listWindows()).windows;
    const owned = windows.filter((entry) => entry.processId === pid);
    const target =
      owned.find((entry) => entry.state === 'foreground') ??
      owned.find((entry) => /ParadigmEve/i.test(entry.title)) ??
      owned[0] ??
      (process.platform === 'win32'
        ? windows.find((entry) => dedicatedParadigmEveChromeWindow(entry, run.browser) && entry.state === 'foreground') ??
          windows.find((entry) => dedicatedParadigmEveChromeWindow(entry, run.browser))
        : undefined);
    if (!target) {
      throw new Error('The ParadigmEve Eve Browser window is not available. Return to Guided setup and try again.');
    }
    await navigateDedicatedChromeWindow(target.id, url, { newTab: true });
    return;
  }

  await openParadigmEveChromeProfile(url, current?.browser ?? selectedChatBrowser());
}

/** Launch the ordinary dedicated Chrome profile with caller-owned browser arguments. */
async function launchParadigmEveChromeProfile(args: string[], browser: ChatBrowser = selectedChatBrowser()): Promise<void> {
  const family = chatBrowserFamily(browser);
  const browserPath = findPreferredBrowser(process.platform, process.env, undefined, undefined, browser);
  if (!browserPath) throw new Error(`${family.label} was not found. Install it or choose another Eve Browser before continuing ParadigmEve setup.`);
  const profile = path.join(app.getPath('userData'), PARADIGMEVE_BROWSER_PROFILE[browser]);
  const child = spawn(browserPath, [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.platform === 'win32' ? WINDOWS_UNTHROTTLED_CHAT_FLAGS : []),
    ...args,
  ], { stdio: 'ignore', windowsHide: false });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
}

/**
 * Open a normal tab in ParadigmEve's dedicated selected-browser profile.
 *
 * Recovery deliberately does not use this helper: supplying a provider URL to Chrome creates a
 * replacement tab before Chrome has had a chance to restore its durable previous session.
 */
export async function openParadigmEveChromeProfile(
  url = CHATGPT_URL,
  browser: ChatBrowser = selectedChatBrowser(),
): Promise<void> {
  await launchParadigmEveChromeProfile([url], browser);
}

function dedicatedParadigmEveChromeWindow(window: WindowInfo, browser: ChatBrowser = selectedChatBrowser()): boolean {
  const appId = window.app?.toLowerCase() ?? '';
  const processName = (window.process ?? '').toLowerCase().replace(/\.exe$/u, '');
  if (processName !== PARADIGMEVE_BROWSER_PROCESS[browser]) return false;

  // Preserve the exact long-lived Chrome identity older ParadigmEve installs already own.
  if (browser === 'chrome') return appId === 'chrome.setupbrowserprofile.default';

  // Chromium derives the profile part of a Windows AppUserModelID from the user-data directory,
  // but each Chromium-family browser owns its own base AppID. Do not guess Microsoft/Brave base
  // prefixes here. Require the exact ParadigmEve family-scoped profile suffix plus the native
  // executable path for the selected family. Missing native identity is deliberately not enough.
  const appUserModelId = window.appUserModelId?.toLowerCase() ?? '';
  const processPath = (window.processPath ?? '').replace(/\//gu, '\\').toLowerCase();
  return appUserModelId.endsWith(PARADIGMEVE_BROWSER_PROFILE_APP_SUFFIX[browser]) &&
    processPath.endsWith(PARADIGMEVE_BROWSER_PROCESS_PATH_SUFFIX[browser]);
}

/**
 * Whether the exact dedicated ParadigmEve Chrome profile currently has a native window.
 * A generic Chrome process is deliberately not enough evidence because the user's normal
 * profile may still be open while Eve's owned profile is closed.
 */
export async function paradigmeEveBrowserWindowOpen(): Promise<boolean | null> {
  if (process.platform !== 'win32') return null;
  try {
    const browser = selectedChatBrowser();
    return (await listWindows()).windows.some((entry) => dedicatedParadigmEveChromeWindow(entry, browser));
  } catch {
    return null;
  }
}

/**
 * Everyday recovery for the dedicated ParadigmEve browser, separate from Guided setup.
 * Concurrent clicks share one attempt. On Windows, Chrome's native previous-session restore gets
 * first claim after an app/browser restart; only a settled Companion census proving zero ChatGPT
 * tabs may create one fresh fallback tab. Other platforms retain their ordinary open behavior.
 */
export async function restoreParadigmEveBrowser(
  chatTabOpen?: () => boolean | null | Promise<boolean | null>,
  options: { waitForRestoreOffer?: boolean; openFreshChatWhenEmpty?: boolean } = {},
): Promise<void> {
  if (restoreBrowserTask) return restoreBrowserTask;
  const task = (async () => {
    const browser = selectedChatBrowser();
    if (process.platform === 'win32') {
      const windows = (await listWindows()).windows.filter((entry) => dedicatedParadigmEveChromeWindow(entry, browser));
      const target = windows.find((entry) => entry.state === 'foreground') ?? windows[0];
      if (target) {
        // An app restart can race Chrome publishing its native post-crash Restore affordance.
        // Startup callers opt into the bounded wait; explicit user repair still performs one
        // immediate check. If native Restore was invoked, stop here and let the restored session
        // repopulate its own Eve/worker and human tabs instead of racing it with a replacement.
        if (await restoreChromePagesIfOffered(target.id, options.waitForRestoreOffer === true)) return;
        // A window can outlive its last ChatGPT tab. Use the Companion's exact tab census rather
        // than the broader 60-second authenticated-presence TTL, because `/closed` itself is
        // authenticated traffic and deliberately keeps that liveness clock warm.
        if (chatTabOpen) {
          const current = await chatTabOpen();
          if (current === true) {
            await focusDedicatedBrowserWindowForRecovery(target, browser);
            return;
          }
          if (current === null) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const settled = await chatTabOpen();
            // Unknown census cannot prove the restored session lacks ChatGPT tabs. Leave the
            // preserved browser alone; a later exact census/user action may safely retry.
            if (settled === true) {
              await focusDedicatedBrowserWindowForRecovery(target, browser);
              return;
            }
            if (settled !== false) return;
          }
          // "Restore Eve Browser" means the dedicated window exists but its ChatGPT tab does not.
          // Opening that one missing tab needs no foreground activation. Windows can legitimately
          // refuse SetForegroundWindow while the user is in another app; that must not turn a safe
          // repair into a raw FOCUS_FAILED toast before the repair even starts.
          if (options.openFreshChatWhenEmpty !== false) {
            await openParadigmEveChromeProfile(CHATGPT_URL, browser);
          }
          return;
        }
        await focusDedicatedBrowserWindowForRecovery(target, browser);
        return;
      }
    }

    if (process.platform !== 'win32') {
      if (options.openFreshChatWhenEmpty !== false) {
        await openParadigmEveChromeProfile(CHATGPT_URL, browser);
      }
      return;
    }

    // A closed dedicated profile owns a durable Chrome session. Start it without a provider URL,
    // let Chrome offer/perform native session restore first, and only create a fresh ChatGPT tab
    // after the Companion can positively prove that no ChatGPT tab returned.
    const recovered = await restoreParadigmEveChromeSessionForRecovery();
    if (recovered?.restoredPages) return;
    if (chatTabOpen) {
      const current = await chatTabOpen();
      if (current === true) return;
      if (current === null) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const settled = await chatTabOpen();
        if (settled !== false) return;
      }
      if (options.openFreshChatWhenEmpty !== false) {
        await openParadigmEveChromeProfile(CHATGPT_URL, browser);
      }
    }
  })();
  restoreBrowserTask = task;
  try {
    await task;
  } finally {
    if (restoreBrowserTask === task) restoreBrowserTask = null;
  }
}

async function waitForDedicatedParadigmEveChromeWindow(
  timeoutMs = 5000,
  browser: ChatBrowser = selectedChatBrowser(),
): Promise<WindowInfo> {
  const deadline = Date.now() + timeoutMs;
  do {
    const windows = (await listWindows()).windows.filter((entry) => dedicatedParadigmEveChromeWindow(entry, browser));
    const target = windows.find((entry) => entry.state === 'foreground') ?? windows[0];
    if (target) return target;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (true);
  throw new Error('The dedicated ParadigmEve Eve Browser profile did not expose a recoverable window.');
}

/**
 * Restart only ParadigmEve's dedicated Chrome profile after an installer/update replaced the
 * bundled unpacked Companion files.
 *
 * Replacing files on disk does not replace an already-running MV3 service worker. Recovery must
 * also not visit chrome://extensions or ask the user/agent to close the last ChatGPT tab by hand.
 * Chrome's own restart command is the narrow ownership boundary we need here: it restarts that
 * profile as a whole, naturally loads the new extension generation and preserves the browser's
 * durable tab session. A closed profile needs no restart because its next launch will already load
 * the current bytes.
 *
 * Returns true only when an already-open dedicated profile was restarted. A false result means the
 * profile was closed and ordinary restore-last-session recovery should launch it normally.
 */
export async function restartParadigmEveChromeForInstallerRecovery(timeoutMs = 10_000): Promise<boolean> {
  if (!extensionDir()) {
    throw new Error('The packaged ParadigmEve Companion could not be materialized for installer recovery.');
  }
  if (process.platform !== 'win32') return false;
  const browser = selectedChatBrowser();
  const existing = (await listWindows()).windows.filter((entry) => dedicatedParadigmEveChromeWindow(entry, browser));
  const target = existing.find((entry) => entry.state === 'foreground') ?? existing[0];
  if (!target) return false;

  // Dispatch only through the exact dedicated profile omnibox. The restart may destroy the
  // target window before the desktop helper has finished returning from the keypress, so a
  // post-dispatch helper error is not failure by itself; the replacement-window census below is
  // authoritative.
  let dispatchError: unknown = null;
  let dispatchedTarget = target;
  try {
    dispatchedTarget = await navigateDedicatedBrowserWindowForRecovery(
      target,
      PARADIGMEVE_BROWSER_RESTART_URL[browser],
      {},
      browser,
    );
  } catch (error) {
    dispatchError = error;
  }

  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let sawOriginalDisappear = false;
  do {
    const windows = (await listWindows()).windows.filter((entry) => dedicatedParadigmEveChromeWindow(entry, browser));
    const originalStillPresent = windows.some((entry) => entry.id === dispatchedTarget.id);
    if (!originalStillPresent) sawOriginalDisappear = true;
    const replacement = windows.find((entry) => entry.id !== dispatchedTarget.id) ??
      (sawOriginalDisappear ? windows[0] : undefined);
    if (replacement) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (true);

  if (dispatchError instanceof Error) throw dispatchError;
  throw new Error('The dedicated ParadigmEve Eve Browser profile did not return after installer recovery restarted it.');
}

async function restoreChromePagesIfOffered(windowId: number, waitForOffer: boolean): Promise<boolean> {
  // Chrome can expose its top-level window before the post-crash restore bubble has joined the
  // BrowserRootView. Recovery used to check an already-open window exactly once, so a perfectly
  // normal startup race left "Restore pages?" sitting on screen indefinitely. Keep this one
  // recovery action bounded, but give Chrome enough time to publish both the notice and its
  // native Restore button before concluding that no native session restore is being offered.
  const attempts = waitForOffer ? 21 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const notice = await findUi({ window: windowId, query: 'Restore pages', maxResults: 10 });
    const offered = notice.elements.some((entry) => entry.name.trim().toLowerCase().startsWith('restore pages'));
    if (offered) {
      const buttons = await findUi({ window: windowId, query: 'Restore', role: 'button', maxResults: 10 });
      const restore = buttons.elements.find((entry) => entry.enabled && entry.name.trim().toLowerCase() === 'restore');
      if (restore) {
        await act([
          { type: 'ui_action', ref: restore.ref, action: 'invoke' },
          { type: 'wait', ms: 750 },
        ], { window: windowId });
        return true;
      }
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function restoreChromePagesAcrossDedicatedWindows(
  preferredWindowId: number,
  browser: ChatBrowser,
  waitForOffer: boolean,
): Promise<boolean> {
  // A family-native browser restart can restore an existing chat window and expose Chrome's
  // post-crash Restore affordance in a second blank window. UIA InvokePattern does not require
  // foreground focus, so inspect every app-owned window instead of forcing one arbitrary window
  // to the foreground. That keeps installer focus races from aborting recovery and makes the
  // window that actually owns the native Restore control authoritative.
  const attempts = waitForOffer ? 21 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const windows = (await listWindows()).windows
      .filter((entry) => dedicatedParadigmEveChromeWindow(entry, browser))
      .sort((a, b) => Number(b.id === preferredWindowId) - Number(a.id === preferredWindowId));
    for (const window of windows) {
      const notice = await findUi({ window: window.id, query: 'Restore pages', maxResults: 10 });
      const offered = notice.elements.some((entry) => entry.name.trim().toLowerCase().startsWith('restore pages'));
      if (!offered) continue;
      const buttons = await findUi({ window: window.id, query: 'Restore', role: 'button', maxResults: 10 });
      const restore = buttons.elements.find((entry) => entry.enabled && entry.name.trim().toLowerCase() === 'restore');
      if (!restore) continue;
      await act([
        { type: 'ui_action', ref: restore.ref, action: 'invoke' },
        { type: 'wait', ms: 750 },
      ], { window: window.id });
      return true;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Recover the exact Prime first, then let Chrome restore the rest of its durable session.
 *
 * A blank/New-Tab Chrome surface gives the Companion no ChatGPT document to attach to, which means
 * browser-side recovery logic cannot truthfully reason about Prime ownership yet. When restart
 * recovery has one exact, durable Prime URL, make that conversation the bootstrap anchor in the
 * first dedicated-profile window. Only after that navigation has been issued do we invoke Chrome's
 * native Restore-pages action so human/worker tabs can return around an already-live Prime.
 *
 * With no exact Prime authority, recovery remains native-session-only and never guesses one.
 */
export async function restoreParadigmEveChromeSessionForRecovery(
  options: {
    waitForRestoreOffer?: boolean;
    exactRecoveryUrl?: string;
    exactConversationOpen?: (conversationId: string) => boolean | null | Promise<boolean | null>;
    /**
     * Installer recovery may have just restarted Chrome as a whole. Give the freshly loaded
     * Companion a bounded chance to prove the exact Prime was already restored before replacing
     * the selected tab with the same URL. Ordinary crash/browser recovery keeps its existing
     * bootstrap-first behavior.
     */
    preferRestoredExact?: boolean;
  } = {},
): Promise<(WindowInfo & { restoredPages: boolean }) | null> {
  const browser = selectedChatBrowser();
  let exactRecoveryUrl: string | null = null;
  let exactConversationId: string | null = null;
  if (options.exactRecoveryUrl !== undefined) {
    const parsed = new URL(options.exactRecoveryUrl);
    const encoded = parsed.pathname.match(/^\/c\/([^/]+)$/)?.[1];
    let conversationId = '';
    try { conversationId = encoded ? decodeURIComponent(encoded) : ''; } catch { /* invalid encoding */ }
    if (
      parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || parsed.port ||
      parsed.search || parsed.hash || !conversationId || conversationId.length < 8 || conversationId.length > 64 ||
      /[\s/\\?#]/.test(conversationId)
    ) {
      throw new Error('Exact recovery URL is not one proven ChatGPT conversation.');
    }
    exactConversationId = conversationId;
    exactRecoveryUrl = `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
  }
  if (process.platform !== 'win32') {
    await launchParadigmEveChromeProfile(['--restore-last-session'], browser);
    return null;
  }

  let target = (await listWindows()).windows.filter((entry) => dedicatedParadigmEveChromeWindow(entry, browser))
    .sort((a, b) => (a.state === 'foreground' ? -1 : 0) - (b.state === 'foreground' ? -1 : 0))[0];
  if (!target) {
    await launchParadigmEveChromeProfile(['--restore-last-session'], browser);
    target = await waitForDedicatedParadigmEveChromeWindow(5000, browser);
  }

  // Exact Prime authority outranks Chrome's native Restore ordering. Put Prime in the current
  // dedicated tab first so the Companion has a real ChatGPT document to bind to immediately and
  // the user always has one obvious recovery surface: first tab = Prime. This deliberately reuses
  // the existing tab instead of opening a second Eve window or side tab.
  if (exactRecoveryUrl) {
    let ready = false;
    if (options.preferRestoredExact && options.exactConversationOpen && exactConversationId) {
      const deadline = Date.now() + 10_000;
      do {
        if (await options.exactConversationOpen(exactConversationId) === true) {
          ready = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (true);
    }

    if (!ready) {
      target = await navigateDedicatedBrowserWindowForRecovery(target, exactRecoveryUrl, { settleMs: 300 }, browser);
    }
    if (!ready && options.exactConversationOpen && exactConversationId) {
      const deadline = Date.now() + 10_000;
      do {
        if (await options.exactConversationOpen(exactConversationId) === true) {
          ready = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (true);
      // Prime did not prove itself live yet. Keep the native Restore affordance available for a
      // later pass instead of replacing the one page the Companion still needs to attach to.
      if (!ready) return { ...target, restoredPages: false };
    }
  }

  // Once Prime navigation has been issued, native Restore may bring back the rest of the old
  // session. If there was no exact Prime authority, native Restore remains the only opening action.
  const restoredPages = await restoreChromePagesAcrossDedicatedWindows(
    target.id,
    browser,
    options.waitForRestoreOffer !== false,
  );
  return { ...target, restoredPages };
}

async function chromeAddressBarRef(windowId: number): Promise<string> {
  // Setup/maintenance can run while Chrome is being relaunched and win the race with foreground
  // activation. Do not rely on Ctrl+L: if that shortcut lands before Chrome owns focus, a later
  // `type` action can put maintenance URLs into the provider page itself. Windows exposes the
  // omnibox as an exact UIA Edit control, so resolve and target that control directly instead.
  await act([{ type: 'focus', window: windowId }, { type: 'wait', ms: 100 }], { window: windowId });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const found = await findUi({ window: windowId, query: 'Address and search bar', role: 'edit', maxResults: 5 });
    const address = found.elements.find((entry) =>
      entry.enabled && entry.name.trim().toLowerCase() === 'address and search bar');
    if (address) return address.ref;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Eve Browser did not expose its address bar for the ParadigmEve browser action.');
}

async function navigateDedicatedChromeWindow(
  windowId: number,
  url: string,
  options: { newTab?: boolean; settleMs?: number } = {},
): Promise<void> {
  if (process.platform !== 'win32') {
    await act([
      { type: 'focus', window: windowId },
      { type: 'wait', ms: 100 },
      { type: 'keypress', keys: [process.platform === 'darwin' ? 'cmd' : 'ctrl', 'l'] },
      { type: 'type', text: url },
      { type: 'keypress', keys: options.newTab ? ['alt', 'enter'] : ['enter'] },
      ...(options.settleMs ? [{ type: 'wait' as const, ms: options.settleMs }] : []),
    ], { window: windowId });
    return;
  }

  const addressRef = await chromeAddressBarRef(windowId);
  try {
    await act([
      { type: 'ui_action', ref: addressRef, action: 'focus' },
      { type: 'set_value', ref: addressRef, text: url },
      { type: 'keypress', keys: options.newTab ? ['alt', 'enter'] : ['enter'] },
      ...(options.settleMs ? [{ type: 'wait' as const, ms: options.settleMs }] : []),
    ], { window: windowId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const directCount = typeof error === 'object' && error !== null &&
      typeof (error as { completedCount?: unknown }).completedCount === 'number'
      ? (error as { completedCount: number }).completedCount
      : null;
    const parsedCount = message.match(/\bcompleted_count=(\d+)\b/u);
    const completedCount = directCount ?? (parsedCount ? Number(parsedCount[1]) : null);
    // The Windows helper reports exact partial progress. Two completed actions mean UIA already
    // focused + wrote the URL, but the physical Enter action never committed it. Preserve that
    // fact so recovery can either retry the same target or safely dismiss the dangling draft.
    throw new DedicatedBrowserNavigationError(message, completedCount === 2);
  }
}

class DedicatedBrowserNavigationError extends Error {
  constructor(message: string, readonly stagedUncommittedUrl: boolean) {
    super(message);
    this.name = 'DedicatedBrowserNavigationError';
  }
}

async function dismissDedicatedBrowserAddressDraft(windowId: number): Promise<void> {
  const addressRef = await chromeAddressBarRef(windowId);
  await act([
    { type: 'ui_action', ref: addressRef, action: 'focus' },
    { type: 'keypress', keys: ['escape'] },
  ], { window: windowId });
}

function isRecoveryFocusFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bFOCUS_FAILED:/u.test(message);
}

async function reacquireDedicatedBrowserWindow(
  previous: WindowInfo,
  browser: ChatBrowser,
): Promise<WindowInfo | null> {
  const windows = (await listWindows()).windows.filter((entry) => dedicatedParadigmEveChromeWindow(entry, browser));
  return windows.find((entry) => entry.id === previous.id) ??
    windows.find((entry) => entry.state === 'foreground') ??
    windows[0] ?? null;
}

async function focusDedicatedBrowserWindowForRecovery(
  target: WindowInfo,
  browser: ChatBrowser = selectedChatBrowser(),
): Promise<WindowInfo> {
  let current = target;
  for (let attempt = 0; attempt < RECOVERY_FOCUS_ATTEMPTS; attempt += 1) {
    try {
      await act([{ type: 'focus', window: current.id }], { window: current.id });
      return current;
    } catch (error) {
      if (!isRecoveryFocusFailure(error) || attempt + 1 >= RECOVERY_FOCUS_ATTEMPTS) throw error;
      const reacquired = await reacquireDedicatedBrowserWindow(current, browser);
      if (!reacquired) throw error;
      current = reacquired;
      await new Promise((resolve) => setTimeout(resolve, RECOVERY_FOCUS_RETRY_MS));
    }
  }
  throw new Error('Eve Browser recovery focus exhausted its bounded retry.');
}

/**
 * Recovery may race Windows foreground arbitration while Chrome is relaunching. Retry only the
 * exact FOCUS_FAILED case, reacquiring the same dedicated profile window before each retry. The
 * global desktop focus assertion stays strict, and this never creates a fallback tab/window.
 */
async function navigateDedicatedBrowserWindowForRecovery(
  target: WindowInfo,
  url: string,
  options: { newTab?: boolean; settleMs?: number } = {},
  browser: ChatBrowser = selectedChatBrowser(),
): Promise<WindowInfo> {
  let current = target;
  const stagedWindowIds = new Set<number>();
  const dismissStagedWindows = async (exceptWindowId?: number): Promise<void> => {
    for (const windowId of stagedWindowIds) {
      if (windowId === exceptWindowId) continue;
      await dismissDedicatedBrowserAddressDraft(windowId).catch(() => undefined);
    }
  };
  for (let attempt = 0; attempt < RECOVERY_FOCUS_ATTEMPTS; attempt += 1) {
    try {
      await navigateDedicatedChromeWindow(current.id, url, options);
      // A successful Enter commits the draft in this exact window. If a previous partial attempt
      // mutated a different Eve Browser window before recovery reacquired this one, dismiss that
      // orphaned draft too instead of leaving a second blank browser with the URL hanging in it.
      stagedWindowIds.delete(current.id);
      await dismissStagedWindows(current.id);
      return current;
    } catch (error) {
      if (error instanceof DedicatedBrowserNavigationError && error.stagedUncommittedUrl) {
        stagedWindowIds.add(current.id);
      }
      if (!isRecoveryFocusFailure(error) || attempt + 1 >= RECOVERY_FOCUS_ATTEMPTS) {
        if (stagedWindowIds.size > 0) {
          // Escape restores Chromium's committed address without navigating. This is best-effort:
          // if Windows is still refusing the Eve Browser foreground, strict focus checks prevent
          // cleanup from touching whichever human window currently owns input.
          await dismissStagedWindows();
        }
        throw error;
      }
      const reacquired = await reacquireDedicatedBrowserWindow(current, browser);
      if (!reacquired) {
        if (stagedWindowIds.size > 0) {
          await dismissStagedWindows();
        }
        throw error;
      }
      current = reacquired;
      await new Promise((resolve) => setTimeout(resolve, RECOVERY_FOCUS_RETRY_MS));
    }
  }
  throw new Error('Eve Browser recovery navigation exhausted its bounded focus retry.');
}

async function extensionUpdateButton(windowId: number): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const found = await findUi({ window: windowId, query: 'Update', role: 'button', maxResults: 10 });
    const button = found.elements.find((entry) => entry.enabled && entry.name.trim().toLowerCase() === 'update');
    if (button) return button.ref;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

export interface CompanionMaintenanceRefreshOptions {
  /**
   * Optional live-proof callback supplied by the bridge owner during reinstall/update recovery.
   * The Chrome Update click is only the mutation; success is the current Companion document
   * checking back in afterward.
   */
  ready?: () => boolean | Promise<boolean>;
  /** Bounded wait for the updated content/service-worker generation to report live evidence. */
  readyTimeoutMs?: number;
}

/**
 * Explicitly refreshes Chrome's unpacked Companion for setup/update maintenance.
 *
 * Updating the files on disk is not enough for MV3: Chrome can keep the old service-worker
 * registration indefinitely. Explicit maintenance uses ParadigmEve's existing native Computer Use
 * path against Chrome's own Extensions page in the dedicated profile and invokes
 * the built-in Update control. No provider page is inspected or automated, and no debugging
 * port/Playwright session is created. `runtime.onInstalled` then re-injects the current content
 * script into already-open ChatGPT documents, which must still prove themselves to `/recovery`.
 */
export async function refreshParadigmEveCompanionForMaintenance(
  options: CompanionMaintenanceRefreshOptions = {},
): Promise<void> {
  if (!extensionDir()) throw new Error('The packaged ParadigmEve Companion could not be materialized for recovery.');

  if (process.platform !== 'win32') {
    await restoreParadigmEveChromeSessionForRecovery();
    return;
  }

  const target = await restoreParadigmEveChromeSessionForRecovery({ waitForRestoreOffer: false });
  if (!target) throw new Error('The dedicated ParadigmEve Eve Browser profile did not expose a recoverable window.');

  // Keep the restored session intact. Chrome's Alt+Enter omnibox behavior opens the internal page
  // as a new tab; after the update we close only that temporary management tab, revealing the same
  // restored tab that was selected before maintenance rather than navigating it to a replacement.
  // Target the actual omnibox control rather than trusting Ctrl+L during the maintenance focus
  // race: a missed shortcut must never type `chrome://extensions/` into ChatGPT.
  await navigateDedicatedChromeWindow(target.id, chatBrowserFamily(selectedChatBrowser()).extensionsUrl, { newTab: true, settleMs: 600 });

  let updateRef = await extensionUpdateButton(target.id);
  if (!updateRef) {
    // Developer mode is normally already on because this is an unpacked extension. If the user
    // hid its controls later, re-enable that one Chrome setting only after the page had ample
    // time to expose Update; never guess from a still-loading page.
    const loadUnpacked = await findUi({ window: target.id, query: 'Load unpacked', role: 'button', maxResults: 5 });
    if (loadUnpacked.elements.length === 0) {
      const developer = await findUi({ window: target.id, query: 'Developer mode', role: 'button', maxResults: 5 });
      const toggle = developer.elements.find((entry) => entry.enabled && entry.name.trim().toLowerCase() === 'developer mode');
      if (toggle) {
        await act([{ type: 'ui_action', ref: toggle.ref, action: 'toggle' }, { type: 'wait', ms: 400 }], { window: target.id });
        updateRef = await extensionUpdateButton(target.id);
      }
    }
  }
  if (!updateRef) throw new Error('Eve Browser did not expose its unpacked-extension Update control for ParadigmEve maintenance.');

  await act([
    { type: 'ui_action', ref: updateRef, action: 'invoke' },
    { type: 'wait', ms: 750 },
    { type: 'keypress', keys: ['ctrl', 'w'] },
  ], { window: target.id });

  if (options.ready) {
    const timeoutMs = Math.max(250, Math.min(options.readyTimeoutMs ?? 15_000, 60_000));
    const deadline = Date.now() + timeoutMs;
    do {
      if (await options.ready()) return;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (true);
    throw new Error('The updated ParadigmEve Companion did not report a current live ChatGPT document.');
  }
}

function validateOptions(options: SetupAssistantStartOptions): SetupAssistantStartOptions {
  const name = options.coreConnectorName.trim();
  const description = options.coreConnectorDescription.trim();
  const connectorIconPath = options.connectorIconPath.trim();
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('ParadigmEve app name is invalid.');
  if (!description || description.length > 8000 || /[\u0000\u007f]/.test(description)) throw new Error('ParadigmEve app description is invalid.');
  if (!connectorIconPath || connectorIconPath.length > 4096 || /[\u0000\r\n]/.test(connectorIconPath)) throw new Error('ParadigmEve connector icon path is invalid.');
  const browser = options.browser ?? 'chrome';
  if (!CHAT_BROWSERS.includes(browser)) throw new Error('ParadigmEve setup browser is invalid.');
  if (options.preflight !== undefined && typeof options.preflight !== 'function') throw new Error('ParadigmEve setup preflight is unavailable.');
  if (typeof options.companionPresent !== 'function') throw new Error('ParadigmEve Companion presence check is unavailable.');
  return {
    coreConnectorName: name,
    coreConnectorDescription: description,
    connectorIconPath,
    browser,
    preflight: options.preflight,
    companionPresent: options.companionPresent,
    onCredentials: options.onCredentials,
  };
}

async function closeRun(run: Run): Promise<void> {
  if (run.closePromise) return run.closePromise;
  const closing = (async () => {
    run.abort.abort();
    const loginGuideServer = run.loginGuideServer;
    run.cancelManualSignIn?.();
    run.cancelManualSignIn = null;
    run.loginGuideServer = null;
    if (loginGuideServer?.listening) {
      await new Promise<void>((resolve) => {
        loginGuideServer.close(() => resolve());
        // Stop does not wait for a slow/faulted guide POST to release its keep-alive socket. The
        // request callback still checks run authority after every await before it can publish
        // another setup transition.
        loginGuideServer.closeAllConnections();
      }).catch(() => undefined);
    }
    await stopLoginChrome(run).catch(() => undefined);
  })();
  run.closePromise = closing;
  await closing;
}

export async function startSetupAssistant(rawOptions: SetupAssistantStartOptions): Promise<SetupAssistantCompletion> {
  if (current) throw new Error('ParadigmEve setup is already running.');
  let options: SetupAssistantStartOptions;
  try {
    options = validateOptions(rawOptions);
  } catch (error) {
    const message = setupErrorMessage(error);
    publish({ stage: 'error', running: false, detail: message, error: message });
    throw error;
  }
  const run: Run = {
    chromeProcess: null,
    browser: options.browser ?? 'chrome',
    loginGuideServer: null,
    cancelManualSignIn: null,
    abort: new AbortController(),
    closePromise: null,
    stopping: false,
    completed: false,
  };
  current = run;
  update('starting', 'Checking Guided setup prerequisites before opening the dedicated Eve Browser profile.');

  try {
    const browser = run.browser;
    const family = chatBrowserFamily(browser);
    const browserPath = findPreferredBrowser(process.platform, process.env, undefined, undefined, browser);
    if (!browserPath) throw new Error(`${family.label} was not found. Install it or choose another Eve Browser before starting ParadigmEve setup.`);
    const extension = extensionDir();
    if (!extension) throw new Error('The ParadigmEve Companion extension folder is unavailable. Reinstall ParadigmEve.');
    const profile = path.join(app.getPath('userData'), PARADIGMEVE_BROWSER_PROFILE[browser]);
    await options.preflight?.(run.abort.signal);
    requireActiveRun(run);
    const providerGuide = await startManualProviderGuide(run, options, extension);
    requireActiveRun(run);
    const chromeArgs = [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(process.platform === 'win32' ? WINDOWS_UNTHROTTLED_CHAT_FLAGS : []),
      providerGuide.url,
    ];
    const chromeProcess = spawn(browserPath, chromeArgs, { stdio: 'ignore', windowsHide: false });
    run.chromeProcess = chromeProcess;
    chromeProcess.on('error', (error) => run.cancelManualSignIn?.(error));
    chromeProcess.once('exit', (code) => {
      if (run.chromeProcess === chromeProcess && !run.stopping && current === run) {
        void (async () => {
          // Chrome is single-instance per profile. When the dedicated profile is already open,
          // this child can exit 0 immediately after handing the guide URL to that existing
          // browser. On Windows its stable app identity proves that handoff; a missing window or
          // nonzero exit remains a real launch/lifetime failure.
          if (code === 0 && process.platform === 'win32') {
            try {
              await waitForDedicatedParadigmEveChromeWindow(1500, browser);
              return;
            } catch { /* Fall through to the visible setup error below. */ }
          }
          if (run.chromeProcess === chromeProcess && !run.stopping && current === run) {
            run.cancelManualSignIn?.(new Error(`The dedicated ParadigmEve ${family.label} window closed before setup could continue${code === null ? '.' : ` (exit ${code}).`} Reopen guided setup and try once more.`));
          }
        })();
      }
    });
    await waitForChromeSpawn(chromeProcess, family.label);
    requireActiveRun(run);
    update('chatgpt-signin', 'Use the ParadigmEve guide in Eve Browser. No automation or debugging is active on provider pages.');
    const completion = await providerGuide.waitForCompletion;
    requireActiveRun(run);
    run.cancelManualSignIn = null;
    run.completed = true;
    update('complete', 'ParadigmEve browser setup is complete. Provider pages remained in Eve Browser throughout.');
    return completion;
  } catch (error) {
    await closeRun(run);
    if (current === run) current = null;
    if (run.stopping || error instanceof SetupAssistantStoppedError) {
      update('stopped', 'ParadigmEve setup was stopped.');
      throw error instanceof SetupAssistantStoppedError ? error : new SetupAssistantStoppedError();
    }
    const message = setupErrorMessage(error);
    update('error', message, message);
    throw error;
  }
}

export async function stopSetupAssistant(): Promise<void> {
  const run = current;
  if (!run) {
    if (state.stage !== 'stopped') publish({ stage: 'stopped', running: false, detail: 'ParadigmEve setup is not running.', error: null });
    return;
  }
  run.stopping = true;
  await closeRun(run);
  if (current === run && run.completed) {
    current = null;
    update('stopped', 'ParadigmEve setup browser was closed.');
  } else {
    publish({ stage: 'stopped', running: false, detail: 'Stopping ParadigmEve setup…', error: null });
  }
}
