const BASIC_ID_PATTERN = /^@[A-Za-z0-9._-]{2,50}$/;

/**
 * The add-friend link LINE serves for an OA. A basic id is already stored per OA, so the URL never
 * has to be typed by hand — but only the OA the visitor actually came through is known at click time,
 * which is why callers pass that row's basic id rather than a global setting.
 */
export function oaFriendUrl(basicId: unknown): string | null {
  return typeof basicId === 'string' && BASIC_ID_PATTERN.test(basicId) ? `https://line.me/R/ti/p/${basicId}` : null;
}
