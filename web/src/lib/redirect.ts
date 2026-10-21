/**
 * Returns `raw` when it is a same-origin path that is safe to navigate to after sign-in, otherwise "/".
 * Rejects absolute and protocol-relative URLs (`//host`, `/\host`) and the login page itself.
 */
export function safeRedirect(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/^\/login(?:[/?#]|$)/.test(raw)) return "/";
  // Control characters (tab, newline) are stripped by URL parsers and can turn "/\t/host" into "//host".
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}
