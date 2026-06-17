/**
 * Review-surface detective copy — minimal, in keeping with the rest of the app.
 */

export const ALL_CLEAR = 'Nothing looks out of place.';
export const NEXT_LEAD = 'Review next';
export const SAVED = 'Saved.';

/** Headline for the attention panel: "N spots flagged for a look", or all-clear. */
export function attentionSummary(n: number): string {
  if (n <= 0) return ALL_CLEAR;
  return `${n} ${n === 1 ? 'spot' : 'spots'} flagged for a look`;
}
