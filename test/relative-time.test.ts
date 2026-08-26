import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../client/relative-time.js';

const NOW = new Date('2026-08-24T12:00:00.000Z').getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('formatRelativeTime', () => {
  it('says "just now" for anything under a minute', () => {
    expect(formatRelativeTime(minutesAgo(0.5), NOW)).toBe('just now');
  });

  it('reports minutes, singular and plural', () => {
    expect(formatRelativeTime(minutesAgo(1), NOW)).toBe('1 min ago');
    expect(formatRelativeTime(minutesAgo(5), NOW)).toBe('5 mins ago');
  });

  it('reports hours once past 60 minutes', () => {
    expect(formatRelativeTime(minutesAgo(60), NOW)).toBe('1 hour ago');
    expect(formatRelativeTime(minutesAgo(150), NOW)).toBe('2 hours ago');
  });

  it('reports days once past 24 hours', () => {
    expect(formatRelativeTime(minutesAgo(60 * 24), NOW)).toBe('1 day ago');
    expect(formatRelativeTime(minutesAgo(60 * 24 * 3), NOW)).toBe('3 days ago');
  });

  it('reports months once past 30 days', () => {
    expect(formatRelativeTime(minutesAgo(60 * 24 * 30), NOW)).toBe('1 month ago');
    expect(formatRelativeTime(minutesAgo(60 * 24 * 30 * 2), NOW)).toBe('2 months ago');
  });

  it('reports years once past 365 days', () => {
    expect(formatRelativeTime(minutesAgo(60 * 24 * 365), NOW)).toBe('1 year ago');
    expect(formatRelativeTime(minutesAgo(60 * 24 * 365 * 2), NOW)).toBe('2 years ago');
  });

  it('never goes negative for a clock-skewed future timestamp', () => {
    expect(formatRelativeTime(new Date(NOW + 10_000).toISOString(), NOW)).toBe('just now');
  });
});
