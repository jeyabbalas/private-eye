/**
 * Popover + menu primitives. `openPopover` mounts arbitrary content in a
 * body-appended `.pe-pop` — placed under its anchor, clamped to the right
 * viewport edge, flipped above when there's no room below — and dismisses on
 * outside-mousedown or Escape, returning focus to the anchor when the popover
 * held it. `openMenu` builds a `role=menu` list on top of it (arrow-key
 * cycling, danger items, non-interactive notes).
 */

export interface PopoverHandle {
  readonly el: HTMLElement;
  close(): void;
}

export interface PopoverOptions {
  onClose?: () => void;
  /** Extra class on the `.pe-pop` shell (applied before placement is measured). */
  className?: string;
}

export function openPopover(anchor: HTMLElement, content: HTMLElement, opts: PopoverOptions = {}): PopoverHandle {
  const pop = document.createElement('div');
  pop.className = 'pe-pop';
  if (opts.className) pop.classList.add(opts.className);
  pop.appendChild(content);
  document.body.appendChild(pop);

  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let top = a.bottom + 6;
  if (top + h > window.innerHeight - 8 && a.top - h - 6 >= 8) top = a.top - h - 6; // flip above
  const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 12)); // right-edge clamp
  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;

  anchor.setAttribute('aria-expanded', 'true');

  let closed = false;
  const onDocDown = (e: MouseEvent): void => {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  // Defer so the click that opened the popover doesn't immediately close it.
  setTimeout(() => {
    if (!closed) document.addEventListener('mousedown', onDocDown);
  }, 0);
  document.addEventListener('keydown', onKey);

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDocDown);
    document.removeEventListener('keydown', onKey);
    const hadFocus = pop.contains(document.activeElement);
    pop.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (hadFocus) anchor.focus();
    opts.onClose?.();
  }

  return { el: pop, close };
}

export type MenuEntry =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | { separator: true }
  | { note: string };

export function openMenu(anchor: HTMLElement, entries: MenuEntry[], opts: PopoverOptions = {}): PopoverHandle {
  const menu = document.createElement('div');
  menu.className = 'pe-menu';
  menu.setAttribute('role', 'menu');

  const items: HTMLButtonElement[] = [];
  for (const entry of entries) {
    if ('separator' in entry) {
      const sep = document.createElement('div');
      sep.className = 'pe-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
    } else if ('note' in entry) {
      const note = document.createElement('div');
      note.className = 'pe-menu-note';
      note.textContent = entry.note;
      menu.appendChild(note);
    } else {
      const b = document.createElement('button');
      b.className = `pe-menu-item${entry.danger ? ' pe-menu-danger' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.textContent = entry.label;
      b.disabled = !!entry.disabled;
      b.addEventListener('click', () => {
        handle.close();
        entry.onSelect();
      });
      menu.appendChild(b);
      if (!entry.disabled) items.push(b);
    }
  }

  menu.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? items[0]!
        : e.key === 'End'
          ? items[items.length - 1]!
          : e.key === 'ArrowDown'
            ? items[(i + 1) % items.length]!
            : items[(i - 1 + items.length) % items.length]!;
    next.focus();
  });

  const handle = openPopover(anchor, menu, { ...opts, className: opts.className ?? 'pe-pop-menu' });
  items[0]?.focus();
  return handle;
}
