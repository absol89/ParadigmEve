// A toy state machine. No network calls occur in this benchmark.
export async function attemptDelivery(row, send) {
  if (row.status === 'acked') return 'complete';
  const result = await send(row.payload);
  if (result === 'acked') {
    row.status = 'acked';
    return 'complete';
  }
  // BUG: an uncertain provider outcome is not equivalent to an explicit rejection.
  row.status = 'pending';
  return 'retry';
}
