/** Canonical relay base URLs. Never include credentials or tokens in a connection URL. */
export function normalizeRelayUrl(input: string, allowBareHost = false): string {
  const raw = input.trim();
  if (!raw || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw)) {
    throw new Error('Enter a valid relay URL without spaces or control characters.');
  }
  let value = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!allowBareHost || /^(?:[a-z][a-z0-9+.-]*:)(?!\d+(?:\/|$))/i.test(value) || /^[/.]/.test(value)) {
      throw new Error('Use an http:// or https:// relay base URL.');
    }
    const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
    value = (loopback ? 'http://' : 'https://') + value;
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('The relay URL is invalid. Check its hostname and port.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('The relay must use http:// or https://.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Use the relay base URL without passwords, tokens, query parameters or fragments.');
  }
  // Accept an accidentally pasted MCP/WebSocket endpoint, but use the base for pairing.
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(?:mcp|ws)$/i, '').replace(/\/+$/, '');
  url.pathname = pathname || '/';
  return url.toString().replace(/\/$/, '');
}

export function isUnencryptedRemoteRelay(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'http:' && !/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname);
}
