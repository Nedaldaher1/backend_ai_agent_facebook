/**
 * Merge a debounced batch of inbound turns into a single logical turn.
 *
 * Pure + deterministic so it is fully unit tested. Duplicate provider message ids
 * within the batch are dropped (a retry that landed mid-window); texts are joined
 * in arrival order; the most recent image / ad ref / name / channel win (the
 * latest signal is the most relevant). The merged `externalMessageId` is a stable
 * batch key derived from the members, so a re-flush dedups in `handleMessage`.
 */

import type { IncomingMessage } from '../agent.service';

export function mergeTurns(items: IncomingMessage[]): IncomingMessage {
  const seen = new Set<string>();
  const deduped = items.filter((m) => {
    if (!m.externalMessageId) return true;
    if (seen.has(m.externalMessageId)) return false;
    seen.add(m.externalMessageId);
    return true;
  });
  const batch = deduped.length > 0 ? deduped : items;

  const first = batch[0];
  const lastWins = <K extends keyof IncomingMessage>(
    key: K,
  ): IncomingMessage[K] | undefined => {
    for (let i = batch.length - 1; i >= 0; i--) {
      const v = batch[i][key];
      if (v) return v;
    }
    return undefined;
  };

  const text = batch
    .map((m) => m.text?.trim())
    .filter((t): t is string => Boolean(t))
    .join('\n');

  const lastImageUrl = lastWins('lastImageUrl');
  const adRef = lastWins('adRef');
  const name = lastWins('name');
  const channel = lastWins('channel');

  const batchKey = `batch:${first.contactId}:${batch
    .map((m, i) => m.externalMessageId ?? `i${i}`)
    .join('-')}`;

  return {
    contactId: first.contactId,
    text,
    ...(lastImageUrl ? { lastImageUrl } : {}),
    ...(adRef ? { adRef } : {}),
    ...(name ? { name } : {}),
    ...(channel ? { channel } : {}),
    externalMessageId: batchKey,
  };
}
