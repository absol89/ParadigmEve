// One page of a list. See SPEC.md.
export function pageOf(items, page, size) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isInteger(page) || page < 1) throw new RangeError(`bad page: ${page}`);
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`bad size: ${size}`);
  const start = page * size;
  return items.slice(start, start + size);
}
