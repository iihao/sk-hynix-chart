const BEIJING_OFFSET_MS = 8 * 3600000;

function toBeijingDate(time) {
  const seconds = typeof time === 'number'
    ? time
    : Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return new Date(seconds * 1000 + BEIJING_OFFSET_MS);
}

function two(value) {
  return String(value).padStart(2, '0');
}

export function formatBeijingTickTime(time) {
  const date = toBeijingDate(time);
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

export function formatBeijingCrosshairTime(time) {
  const date = toBeijingDate(time);
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${date.getUTCDate()} ${date.getUTCMonth() + 1}月 '${year} ${formatBeijingTickTime(time)}`;
}

export function formatBeijingOhlcTime(time) {
  const date = toBeijingDate(time);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()} ${formatBeijingTickTime(time)}`;
}
