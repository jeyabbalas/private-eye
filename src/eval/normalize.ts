/**
 * Text normalization shared by every metric. The goal: make convention-level
 * differences (curly vs straight quotes, dash variants, bold markers, spacing)
 * invisible to scoring, while keeping genuine content differences visible.
 */

const DASHES = /[‐‑‒–—―−]/g; // hyphen variants, en/em dash, minus
const QUOTES_SINGLE = /[‘’‚‛′]/g;
const QUOTES_DOUBLE = /[“”„‟″]/g;

/** Light normalization that preserves content: NFKC, fold dashes/quotes, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(QUOTES_SINGLE, "'")
    .replace(QUOTES_DOUBLE, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Case-folded normalization — the primary text-fidelity comparison form. */
export function normalizeFold(s: string): string {
  return normalizeText(s).toLowerCase();
}

/** Collapse to comparable id form: drop spaces/punctuation, lowercase. */
export function normalizeId(s: string): string {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[\s.\-/]/g, '');
}

/** Date form: lowercase, drop commas/periods, collapse spaces. Printed forms compare directly. */
export function normalizeDate(s: string): string {
  return normalizeText(s).toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizeName(s: string): string {
  return normalizeText(s).toLowerCase();
}

export function normalizeField(value: string, kind: 'date' | 'id' | 'name' | 'text'): string {
  switch (kind) {
    case 'id':
      return normalizeId(value);
    case 'date':
      return normalizeDate(value);
    case 'name':
    case 'text':
      return normalizeName(value);
  }
}

/** Extract numeric tokens (for fabrication / number checks). Keeps digit groups. */
export function extractNumbers(s: string): string[] {
  const out: string[] = [];
  for (const m of normalizeText(s).matchAll(/\d[\d.,/:%-]*\d|\d/g)) {
    // strip trailing punctuation, keep internal separators
    const tok = m[0].replace(/[.,/:%-]+$/, '');
    if (/\d/.test(tok)) out.push(tok);
  }
  return out;
}

/** Extract alphabetic words of a minimum length, case-folded. */
export function extractWords(s: string, minLen = 4): string[] {
  const out: string[] = [];
  for (const m of normalizeFold(s).matchAll(/[a-z]+/g)) {
    if (m[0].length >= minLen) out.push(m[0]);
  }
  return out;
}
