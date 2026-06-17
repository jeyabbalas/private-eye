/**
 * The verdict banner: one plain-language sentence about how the page's read went,
 * derived from the verifier result (and, in Deep Read, any safety fallback). It's
 * the reviewer's at-a-glance "is this clean, or should I look?" — tone-colored,
 * never jargon. Static for the life of a page (the verdict is immutable).
 */
import type { VerificationResult } from '../structure/verify.ts';
import { pipelineLabel, verdictView } from './labels.ts';
import { escapeHtml } from '../ui/progress.ts';

export function createVerdictBanner(
  verification: VerificationResult | undefined,
  pipeline: 'E' | 'G',
  fellBack: boolean,
): HTMLElement {
  const view = verdictView(verification, fellBack);
  const el = document.createElement('div');
  el.className = `pe-verdict pe-verdict-${view.tone}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="pe-verdict-dot" aria-hidden="true"></span>
    <div class="pe-verdict-text">
      <div class="pe-verdict-title">${escapeHtml(view.title)}</div>
      <div class="pe-verdict-detail">${escapeHtml(view.detail)}</div>
    </div>
    <div class="pe-verdict-mode" title="How this page was read">${escapeHtml(pipelineLabel(pipeline))}</div>`;
  return el;
}
