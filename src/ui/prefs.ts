/**
 * UI preferences: a tiny JSON-in-localStorage wrapper. App data lives in
 * IndexedDB; these are view preferences only (rail collapsed, split ratio),
 * namespaced `pe.*`, so losing them is harmless. Private-mode safe: every
 * localStorage touch is try/caught and failure just means "no preference".
 */

export function readPref<T>(key: string, validate: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const value: unknown = JSON.parse(raw);
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota exceeded — the preference just doesn't persist.
  }
}
