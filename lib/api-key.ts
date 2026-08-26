/**
 * Client-side handling of the user's Anthropic API key.
 *
 * The key lives in this browser's localStorage and is sent on each extraction request. The server
 * uses it to make the call and never logs or persists it. It is deliberately NOT read from a
 * server environment variable — every user brings their own key, so nobody spends someone else's
 * credits.
 */

export const API_KEY_STORAGE_KEY = "recipe-flow:anthropic-api-key";
export const API_KEY_HEADER = "x-anthropic-api-key";

/** localStorage throws in some privacy modes, so every access is guarded. */
export function loadApiKey(): string | null {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveApiKey(key: string): void {
  try {
    window.localStorage.setItem(API_KEY_STORAGE_KEY, key.trim());
  } catch {
    // Nothing to do — the key still works for this page load.
  }
}

export function forgetApiKey(): void {
  try {
    window.localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/** A cheap shape check so an obvious paste error is caught before spending a round trip. */
export function looksLikeApiKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("sk-ant-") && trimmed.length >= 20;
}

/** For display only. Never render a full key back to the page. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 11)}…${trimmed.slice(-4)}`;
}
