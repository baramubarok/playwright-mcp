// Matches CSI/OSC terminal escape sequences that Playwright embeds in error messages.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

/** Truncate to a character budget, keeping the head and marking how much was dropped. */
export function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… [${value.length - limit} more characters truncated]`;
}

/** Keep the tail of a log, where process failures usually explain themselves. */
export function tailText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[${value.length - limit} earlier characters truncated] …${value.slice(-limit)}`;
}
