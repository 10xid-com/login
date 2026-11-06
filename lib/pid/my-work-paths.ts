/** Pure path rules for the shared PiD My Work page. Safe to import from anywhere, client or server. */
export const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** A card id is an opaque token: letters, digits, dash or underscore, bounded. */
export const CARD_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

export const MY_WORK_PATH = "/auth/pid/my-work";

/** Whether `path` is the My Work list or one deck of it. Used to resume sign-in on this page. */
export function isMyWorkPath(path: string): boolean {
  if (path === MY_WORK_PATH) return true;
  return path.startsWith(`${MY_WORK_PATH}/`) && UUID.test(path.slice(MY_WORK_PATH.length + 1));
}

export function deckPath(deck: string): string {
  return `${MY_WORK_PATH}/${deck}`;
}
