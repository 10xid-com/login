/** Shared UiD member policy. Role names and management boundaries match the portal matrix. */
export const ROLES = ["owner", "manager", "editor", "publisher", "asset_manager", "viewer"] as const;
export type BusinessRole = typeof ROLES[number];
export const ROLE_LABELS: Record<BusinessRole, string> = {
  owner: "Owner", manager: "Manager", editor: "Editor", publisher: "Publisher",
  asset_manager: "Asset manager", viewer: "Viewer",
};
export const ACCESS_LABELS = ["No access", "View only", "Edit", "Edit and publish"] as const;
export const CLOTHING_CAPABILITIES = ["clothing.read", "clothing.write", "clothing.publish"] as const;
export function isRole(value: unknown): value is BusinessRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
export function managesMembers(role: string): boolean { return role === "owner" || role === "manager"; }
export function mayChange(actor: string, before: string, after: string): boolean {
  return managesMembers(actor) && isRole(after) &&
    (actor === "owner" || (before !== "owner" && after !== "owner"));
}
export function clothingLevel(role: string, rows: { capability: string; deny: boolean }[]): number {
  if (!isRole(role)) return 0;
  let level = 0;
  for (const capability of CLOTHING_CAPABILITIES) {
    const matching = rows.filter(row => row.capability === capability);
    // Deny wins, including over an owner's role. Each level needs all lower levels.
    if (matching.some(row => row.deny) || (role !== "owner" && !matching.some(row => !row.deny))) break;
    level++;
  }
  return level;
}
export function requiredClothingLevel(method: string, pathname: string): number {
  if (method === "GET" || method === "HEAD") return 1;
  return /\/publish$/.test(pathname) ? 3 : 2;
}
export class MemberError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
