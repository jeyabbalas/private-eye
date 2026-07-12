/**
 * Shared inline SVG icons — one 24-viewBox stroke style (2px, round caps) so
 * every glyph reads as the same family at any size. Sized by width/height
 * attributes; contexts that need another size override via CSS.
 */

const attrs = (size: number, strokeWidth = 2): string =>
  `viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;

/** Deep Read sparkles. */
export const ICON_DEEP = `<svg ${attrs(15)}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z"/></svg>`;

export const ICON_DOWNLOAD = `<svg ${attrs(15)}><path d="M12 3v12"/><path d="m7 11 5 4 5-4"/><path d="M5 21h14"/></svg>`;

export const ICON_TRASH = `<svg ${attrs(15)}><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/></svg>`;

export const ICON_CHEVRON_LEFT = `<svg ${attrs(14, 2.2)}><path d="m15 6-6 6 6 6"/></svg>`;

export const ICON_CHEVRON_RIGHT = `<svg ${attrs(14, 2.2)}><path d="m9 6 6 6-6 6"/></svg>`;

/** Two stacked pages: copy to clipboard. */
export const ICON_COPY = `<svg ${attrs(15)}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;

/** Horizontal ellipsis: the overflow menu. */
export const ICON_ELLIPSIS = `<svg ${attrs(15, 2.6)}><path d="M5 12h.01"/><path d="M12 12h.01"/><path d="M19 12h.01"/></svg>`;

/** Marquee corners + plus: mark a missed area for re-reading. */
export const ICON_MARK = `<svg ${attrs(15)}><path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M12 9v6"/><path d="M9 12h6"/></svg>`;

export const ICON_UNDO = `<svg ${attrs(15)}><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;

/** Panel-left glyph: the document-rail toggle. */
export const ICON_SIDEBAR = `<svg ${attrs(16)}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>`;

export const ICON_ADD = `<svg ${attrs(15)}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
