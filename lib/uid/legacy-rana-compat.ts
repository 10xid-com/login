/**
 * LEGACY, UNVERIFIED compatibility for the 10XiD pilot's Rana pair.
 *
 * These two account ids were pasted in before verified sign-in links existed.
 * Nobody has proven control of both accounts through the link flow, so this is
 * NOT a verified link and is never written to signin_links. It stays exactly as
 * narrow as it was: display-only, one PiD host, and removable once the pair
 * completes the real flow (docs/verified-signin-links.md).
 */
export const LEGACY_RANA_ACCOUNTS = ["bbb11aae-61de-4bdf-ae62-6be722ba9ab4", "0145e895-4ea1-4d73-b692-e2b07c883875"] as const;
export const LEGACY_RANA_HOST = "uid-rana.10xid.com";

/** The other legacy Rana account, only for that host and only for one of the pair. */
export function legacyLinkedAccount(host: unknown, userId: string): string | undefined {
  if (host !== LEGACY_RANA_HOST || !LEGACY_RANA_ACCOUNTS.includes(userId as never)) return undefined;
  return LEGACY_RANA_ACCOUNTS.find(id => id !== userId);
}
export const isLegacyRanaAccount = (id: string) => LEGACY_RANA_ACCOUNTS.includes(id as never);
export const isLegacyRanaPrimary = (id: string) => id === LEGACY_RANA_ACCOUNTS[0];
