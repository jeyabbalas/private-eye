/** Markdown -> HTML for the output panes. GFM is required for the pipe tables
 *  renderMarkdown emits; micromark's default allowDangerousHtml=false entity-
 *  escapes any raw HTML that OCR'd text might contain. */
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

export function mdToHtml(md: string): string {
  return micromark(md, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
}
