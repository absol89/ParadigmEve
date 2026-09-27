(function () {
  const root = document.documentElement;
  const body = document.body;

  function qs(selector, scope = document) { return scope.querySelector(selector); }
  function qsa(selector, scope = document) { return [...scope.querySelectorAll(selector)]; }

  const coffeeModeEnabled = false;
  const coffeeButton = qs('[data-coffee-toggle]');
  let storedCoffee = null;
  try { storedCoffee = localStorage.getItem('eve-readme-coffee-mode'); } catch {}
  if (coffeeModeEnabled && storedCoffee === 'on') body.classList.add('coffee-mode');
  else body.classList.remove('coffee-mode');

  function syncCoffeeButton() {
    if (!coffeeButton) return;
    const on = body.classList.contains('coffee-mode');
    coffeeButton.textContent = on ? '☕ Coffee mode: on' : '☕ Coffee mode';
    coffeeButton.setAttribute('aria-pressed', String(on));
  }
  if (coffeeModeEnabled) syncCoffeeButton();

  if (coffeeModeEnabled) coffeeButton?.addEventListener('click', () => {
    body.classList.toggle('coffee-mode');
    try { localStorage.setItem('eve-readme-coffee-mode', body.classList.contains('coffee-mode') ? 'on' : 'off'); } catch {}
    syncCoffeeButton();
  });

  qsa('[data-calm-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const board = qs('.messy-board', button.closest('.demo'));
      const calm = board?.classList.toggle('calm');
      button.textContent = calm ? 'Put it back' : 'Make this lighter';
    });
  });

  qsa('[data-quilt]').forEach((quilt) => {
    const result = quilt.parentElement?.querySelector('[data-quilt-result]');
    const stitchedQuilt = quilt.closest('.two-col')?.querySelector('[data-stitched-quilt]');
    qsa('button', quilt).forEach((tile) => {
      tile.addEventListener('click', () => {
        tile.classList.toggle('selected');
        tile.setAttribute('aria-pressed', String(tile.classList.contains('selected')));
        const count = qsa('button.selected', quilt).length;
        if (result) result.textContent = count ? `${count} Pin${count === 1 ? '' : 's'} selected. Pick the ones worth keeping for later.` : 'Pick the Pins worth keeping for later.';
      });
    });
    quilt.parentElement?.querySelector('[data-stitch]')?.addEventListener('click', () => {
      const chosen = qsa('button.selected', quilt).map((tile) => tile.textContent.trim());
      if (!chosen.length) {
        if (result) result.textContent = 'Choose at least one Pin first.';
        return;
      }

      if (result) result.textContent = `Showing ${chosen.length} selected Pin${chosen.length === 1 ? '' : 's'} together.`;
      if (!stitchedQuilt) return;

      stitchedQuilt.replaceChildren();
      const side = Math.ceil(Math.sqrt(chosen.length));
      const totalSlots = side * side;
      stitchedQuilt.style.setProperty('--quilt-size', String(side));

      chosen.forEach((label) => {
        const tile = document.createElement('div');
        tile.className = 'stitched-tile saved-bit';
        tile.textContent = label;
        stitchedQuilt.appendChild(tile);
      });

      for (let index = chosen.length; index < totalSlots; index += 1) {
        const filler = document.createElement('div');
        filler.className = `stitched-tile filler filler-${(index - chosen.length) % 5 + 1}`;
        filler.setAttribute('aria-hidden', 'true');
        stitchedQuilt.appendChild(filler);
      }
    });
  });

  qsa('[data-plan]').forEach((plan) => {
    const items = qsa('.plan-item', plan);
    const state = qs('[data-plan-state]', plan);
    function repaint() {
      const done = items.filter((item) => item.classList.contains('done')).length;
      const currentIndex = items.findIndex((item) => !item.classList.contains('done'));
      items.forEach((item, index) => {
        const isDone = item.classList.contains('done');
        item.classList.toggle('current', !isDone && index === currentIndex);
        item.classList.toggle('future', !isDone && currentIndex !== -1 && index > currentIndex);
        item.setAttribute('aria-pressed', String(isDone));
        if (!isDone && index === currentIndex) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      });
      if (!state) return;
      if (done === items.length) {
        state.textContent = 'Everything is checked off. Nice. It still stays here until you archive it.';
        state.classList.add('ready');
      } else {
        state.textContent = `${done} of ${items.length} done. The outlined step is next; later steps stay quieter until you get there.`;
        state.classList.remove('ready');
      }
    }
    items.forEach((item) => item.addEventListener('click', () => {
      item.classList.toggle('done');
      item.setAttribute('aria-pressed', String(item.classList.contains('done')));
      repaint();
    }));
    repaint();
  });

  qsa('[data-workers-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const stage = button.closest('.demo')?.querySelector('.worker-stage');
      const active = stage?.classList.toggle('active');
      button.textContent = active ? 'Bring the pieces back' : 'Split this up';
    });
  });

  const localStatus = qs('[data-local-status]');
  if (localStatus) {
    const isFile = location.protocol === 'file:';
    localStatus.innerHTML = isFile
      ? '<span class="local-dot"></span>You opened this straight from a folder on your computer.'
      : '<span class="local-dot"></span>This page uses no external fonts, scripts, images, or CDNs.';
  }

  const year = qs('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();
