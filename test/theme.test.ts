// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STORAGE_KEY,
  currentTheme,
  resolveTheme,
  setTheme,
  watchSystemTheme,
} from '../client/theme.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveTheme', () => {
  it('prefers a stored choice over the system setting', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('falls back to the system setting when nothing is stored', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
  });

  it('ignores a stored value that is not a theme', () => {
    expect(resolveTheme('chartreuse', true)).toBe('dark');
    expect(resolveTheme('', false)).toBe('light');
  });
});

describe('setTheme', () => {
  it('applies the theme to the document and remembers it', () => {
    setTheme('dark');

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('overwrites a previous choice', () => {
    setTheme('dark');
    setTheme('light');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('still applies the theme when storage refuses to save', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => setTheme('dark')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');

    setItem.mockRestore();
  });
});

describe('currentTheme', () => {
  it('reads what is applied to the document', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(currentTheme()).toBe('dark');

    document.documentElement.dataset.theme = 'light';
    expect(currentTheme()).toBe('light');
  });

  it('treats an unset attribute as light', () => {
    expect(currentTheme()).toBe('light');
  });
});

describe('watchSystemTheme', () => {
  /** Minimal MediaQueryList stand-in whose change event we can fire. */
  function stubMatchMedia() {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) =>
        listeners.delete(fn),
    }));
    return {
      fire: (matches: boolean) => listeners.forEach((fn) => fn({ matches })),
      count: () => listeners.size,
    };
  }

  it('follows the OS while no choice is stored', () => {
    const media = stubMatchMedia();
    const seen: string[] = [];
    watchSystemTheme((theme) => seen.push(theme));

    media.fire(true);

    expect(seen).toEqual(['dark']);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('stops following the OS once a choice is stored', () => {
    const media = stubMatchMedia();
    const seen: string[] = [];
    watchSystemTheme((theme) => seen.push(theme));
    setTheme('light');

    media.fire(true);

    expect(seen).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('unsubscribes', () => {
    const media = stubMatchMedia();
    const stop = watchSystemTheme(() => {});
    expect(media.count()).toBe(1);

    stop();

    expect(media.count()).toBe(0);
  });
});
