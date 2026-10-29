# Coding pitfalls (read only, no tools needed)

Ten short JavaScript functions. Some have a real defect, some are fine. For each one, decide whether it has
a defect that would cause wrong behaviour in normal use. If it does, give the line number (counting from 1
inside that snippet), the defect in one sentence, and the smallest fix. If it's fine, say so. Don't report
style issues, and don't invent a bug to have something to say: a correct "no defect" scores as well as
finding a real one.

Reply with JSON:

```json
{"answers": {"P1": {"defect": true, "line": 2, "why": "...", "fix": "..."}, "P2": {"defect": false}}}
```

**P1**
```js
function topThree(scores) {
  return scores.sort().reverse().slice(0, 3);
}
```

**P2**
```js
async function saveAll(items, db) {
  items.forEach(async item => {
    await db.save(item);
  });
  return 'saved';
}
```

**P3** (the caller keeps using `cart` after calling this)
```js
function applyDiscount(cart, pct) {
  const items = cart.items;
  for (const item of items) item.price = item.price * (1 - pct);
  return { ...cart, items };
}
```

**P4** (`store` is a shared async key-value store used by many requests at once)
```js
async function reserve(store, sku) {
  const stock = await store.get(sku);
  if (stock > 0) {
    await store.set(sku, stock - 1);
    return true;
  }
  return false;
}
```

**P5** (`api.post` can time out after the server has already processed the request)
```js
async function charge(api, order) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await api.post('/charges', { amount: order.total }); }
    catch (e) { if (attempt === 3) throw e; }
  }
}
```

**P6**
```js
function unique(values) {
  return [...new Set(values)];
}
```

**P7**
```js
function page(items, pageNumber, size) {
  // pageNumber starts at 1
  const start = pageNumber * size;
  return items.slice(start, start + size);
}
```

**P8**
```js
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
```

**P9** (a missing or corrupt config file must stop the service from starting)
```js
function loadConfig(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
```

**P10**
```js
async function fetchAll(urls, get) {
  return Promise.all(urls.map(url => get(url)));
}
```
