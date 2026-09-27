// Run with the repository's Electron binary. Uses real Chromium layout and production CSS.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>
    <div class="app" data-screen="chat"><main>
      <section class="panel" data-panel="setup"><div id="guidedSetupStatus"></div></section>
      <section class="panel is-active" data-panel="chat"><section class="card is-session">
        <div class="subhead"></div><div class="scroll" id="chatBody"></div><div class="composer-dock" hidden></div>
        <form id="composer" class="composer">
          <textarea id="chatInput" rows="1" dir="auto" placeholder="Ask anything…"></textarea>
          <div class="composer-toolbar"><button type="button">+</button></div>
        </form><p id="chatFoot"></p>
      </section></section>
    </main></div>`));
  await win.webContents.executeJavaScript(`(() => {
    const app = document.querySelector('.app');
    const setup = document.querySelector('[data-panel="setup"]');
    const chat = document.querySelector('[data-panel="chat"]');
    const status = document.getElementById('guidedSetupStatus');
    const input = document.getElementById('chatInput');
    const composer = document.getElementById('composer');
    window.__composerProbe = {
      input, composer,
      setup(detail) {
        app.dataset.screen = 'setup'; chat.classList.remove('is-active'); setup.classList.add('is-active');
        status.textContent = detail;
      },
      chat() {
        app.dataset.screen = 'chat'; setup.classList.remove('is-active'); chat.classList.add('is-active');
      }
    };
  })()`);
  const results = [];
  const record = async (name) => results.push(await win.webContents.executeJavaScript(`(() => {
    const { input, composer } = window.__composerProbe;
    return { name: ${JSON.stringify(name)}, height: input.clientHeight,
      composerHeight: composer.clientHeight, scrollHeight: input.scrollHeight, scrollTop: input.scrollTop,
      overflow: input.scrollHeight > input.clientHeight };
  })()`));
  const js = code => win.webContents.executeJavaScript(code);

  await record('initial reveal');
  await js(`__composerProbe.input.value = 'Pasted line\\n'.repeat(100); __composerProbe.input.scrollTop = __composerProbe.input.scrollHeight`);
  await record('long paste');
  await js(`__composerProbe.input.value = ''`); await record('clear');
  await js(`__composerProbe.input.value = 'one line'`); await record('short draft');

  for (const [name, detail] of [
    ['after guided start', 'Opening the dedicated browser.'],
    ['after guided stop', 'Guided setup stopped.'],
    ['after guided error', 'Browser setup failed.']
  ]) {
    await js(`__composerProbe.setup(${JSON.stringify(detail)})`);
    await js(`__composerProbe.chat()`);
    await record(name);
  }

  await js(`__composerProbe.input.value = 'wrapped words '.repeat(25)`); await record('wide draft');
  await js(`__composerProbe.composer.style.width = '320px'`); await record('narrow draft');
  await js(`__composerProbe.composer.style.width = ''`); await record('wide again');

  await js(`__composerProbe.input.value = 'one line'`);
  win.setSize(760, 560); await record('small window');
  win.webContents.setZoomFactor(1.5); await record('small window 150% zoom');
  win.webContents.setZoomFactor(0.75); await record('small window 75% zoom');
  win.webContents.setZoomFactor(1); win.setSize(1100, 800); await record('restored window');

  await js(`__composerProbe.setup('Hidden draft restore'); __composerProbe.input.value = 'restored line\\n'.repeat(5); __composerProbe.chat()`);
  await record('hidden draft restore');
  await js(`__composerProbe.input.value = ''`); await record('empty again');
  console.log(JSON.stringify(results, null, 2));
  for (const name of ['initial reveal', 'clear', 'short draft', 'after guided start', 'after guided stop',
    'after guided error', 'wide draft', 'wide again', 'small window', 'small window 150% zoom',
    'small window 75% zoom', 'restored window', 'hidden draft restore', 'empty again']) {
    assert.equal(results.find(r => r.name === name).overflow, false, name + ' must fit without scrolling');
  }
  const long = results.find(r => r.name === 'long paste');
  assert.equal(long.height, 220, 'Long input stays bounded');
  assert.equal(long.overflow, true, 'Long input remains scrollable');
  assert.ok(long.scrollTop > 0, 'Overflowing text can actually scroll');
  assert.equal(results.find(r => r.name === 'clear').scrollTop, 0, 'Clearing also resets the scroll position');
  assert.ok(results.find(r => r.name === 'narrow draft').height > results.find(r => r.name === 'wide draft').height,
    'Width changes must recalculate wrapping without an input event');
  const short = results.find(r => r.name === 'short draft');
  for (const name of ['after guided start', 'after guided stop', 'after guided error', 'small window',
    'small window 150% zoom', 'small window 75% zoom', 'restored window']) {
    const current = results.find(r => r.name === name);
    assert.equal(current.height, short.height, name + ' must keep the one-line textarea height');
    assert.equal(current.composerHeight, short.composerHeight, name + ' must keep the composer block height');
  }
  assert.equal(results.at(-1).height, results[0].height, 'Empty input has stable initial and cleared geometry');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
