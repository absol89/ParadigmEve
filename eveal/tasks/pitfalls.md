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
function toNumbers(strings) {
  return strings.map(parseInt);
}
```

**P2**
```js
function isoDay(year, month, day) {
  // month is 1-12
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}
```

**P3** (`size` is a positive integer)
```js
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```

**P4** (amounts are dollars with cents, such as 19.99)
```js
function isPaidInFull(payments, total) {
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  return paid === total;
}
```

**P5** (`times` are future timestamps in milliseconds)
```js
function scheduleReminders(times, notify) {
  for (var i = 0; i < times.length; i++) {
    setTimeout(() => notify(times[i]), times[i] - Date.now());
  }
}
```

**P6**
```js
async function firstOk(tasks) {
  const errors = [];
  for (const task of tasks) {
    try { return await task(); } catch (e) { errors.push(e); }
  }
  throw new AggregateError(errors, 'all tasks failed');
}
```

**P7** (called many times, on many different strings)
```js
const DIGITS = /^\d+$/g;
function isAllDigits(s) {
  return DIGITS.test(s);
}
```

**P8** (`load` returns a promise that may reject; callers must get `null` on any failure)
```js
async function safeLoad(load) {
  try {
    return load();
  } catch (e) {
    return null;
  }
}
```

**P9** (the result goes into HTML text and quoted attribute values)
```js
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

**P10** (`words` come from text that users type)
```js
function countWords(words) {
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return counts;
}
```
