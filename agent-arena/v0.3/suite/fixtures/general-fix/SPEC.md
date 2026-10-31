# pageOf

`pageOf(items, page, size)` in `src/page-of.js` returns one page of `items` as a new array.

- Pages are numbered from 1. Page 1 holds the first `size` items, page 2 the next `size`, and so on.
- The last page may be shorter. A page after the last one is an empty array.
- `items` must be an array (otherwise `TypeError`). `page` and `size` must be integers of at least 1
  (otherwise `RangeError`).
