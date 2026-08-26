/**
 * Coarse "time ago" label for the topbar's "Updated ..." line — how long since the
 * agent last edited the document under review.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * @param {string} iso
 * @param {number} [now] epoch ms "now" to measure against — injectable for tests
 * @returns {string}
 */
export function formatRelativeTime(iso, now = Date.now()) {
  // Clamped at 0: a clock-skewed future timestamp reads as "just now", not negative minutes.
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), 'min');
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour');
  if (diff < MONTH) return plural(Math.floor(diff / DAY), 'day');
  if (diff < YEAR) return plural(Math.floor(diff / MONTH), 'month');
  return plural(Math.floor(diff / YEAR), 'year');
}
