// One delivery step: claim a row, call the provider, record what it said.
// transport.send(payload) resolves to { outcome: 'acked' | 'rejected' | 'unknown', providerId? }.
export async function runOnce(outbox, transport, workerId, now) {
  const row = await outbox.claimNext(workerId, now);
  if (!row) return null;
  let result;
  try {
    result = await transport.send(row.payload, { id: row.id, attempt: row.attempts });
  } catch {
    // A thrown transport error happens after the request may have left the process.
    result = { outcome: 'unknown' };
  }
  return outbox.recordOutcome(row.id, row.lease.token, result.outcome, now, result.providerId ?? null);
}
