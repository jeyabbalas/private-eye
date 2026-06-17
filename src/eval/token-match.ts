/**
 * Token matching shared by the fabrication (extra tokens) and omission (missing
 * tokens) checks. The forgiveness rule is identical in both directions: a token
 * matches a pool entry if it is present exactly or within edit distance 1 (with a
 * length difference of at most 1), so plain OCR misreads — already paid for in
 * CER — are not double-counted as either hallucination or data loss.
 */
import { distance } from 'fastest-levenshtein';

/** True if tok is in pool exactly, or within edit distance 1 of a pool entry (length diff <= 1). */
export function withinEdit1(tok: string, pool: Set<string>): boolean {
  if (pool.has(tok)) return true;
  for (const g of pool) {
    if (Math.abs(g.length - tok.length) <= 1 && distance(tok, g) <= 1) return true;
  }
  return false;
}

/** Tokens (duplicates preserved) that no pool entry matches under withinEdit1. */
export function tokensMissingFromPool(tokens: string[], pool: Set<string>): string[] {
  return tokens.filter((t) => !withinEdit1(t, pool));
}
