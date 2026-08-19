/**
 * Light/dark theming.
 *
 * A stored choice always wins; with nothing stored the OS decides, and keeps deciding —
 * change the system setting and an untouched tab follows along.
 *
 * The initial value is applied by an inline script in index.html rather than here, so
 * the correct theme is in place before the first paint. `resolveTheme` is the shared
 * rule; keep the two in step if it changes.
 */

export const STORAGE_KEY = 'md-review:theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** @typedef {'light' | 'dark'} Theme */

/**
 * @param {string | null} stored
 * @param {boolean} systemPrefersDark
 * @returns {Theme}
 */
export function resolveTheme(stored, systemPrefersDark) {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemPrefersDark ? 'dark' : 'light';
}

/** localStorage is unavailable in some privacy modes; the theme is not worth throwing over. */
function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** @returns {Theme} the theme currently applied to the document */
export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Applies a theme and remembers it, so it survives reloads and later sessions. */
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persisting failed; the theme still applies for this page.
  }
}

/**
 * Follows the OS while the reader has expressed no preference of their own.
 * @param {(theme: Theme) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function watchSystemTheme(onChange) {
  const query = matchMedia(DARK_QUERY);
  const handler = (event) => {
    if (readStored() !== null) return;
    const theme = event.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    onChange(theme);
  };
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
