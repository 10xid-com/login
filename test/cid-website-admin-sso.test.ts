import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  getLoginSession: vi.fn(), userByAuthUserId: vi.fn(), accountAddresses: vi.fn(), editableCid: vi.fn(),
  mintTicket: vi.fn(), redeemTicket: vi.fn(), authSessionLive: vi.fn(), userById: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/accounts", () => mock);
vi.mock("@/lib/db/cid-profiles", () => mock);
vi.mock("@/lib/db/identity", () => mock);
vi.mock("@/lib/auth/login", () => mock);
vi.mock("@/lib/auth/sso", () => ({
  PRIMARY_HOST: "login.10xid.com", PORTAL_HOST: "app.10xid.com",
  isPrimaryHost: (host: string) => host === "login.10xid.com",
  originFor: (host: string) => `https://${host}`,
  hashTicket: (input: string) => createHash("sha256").update(input).digest(),
}));

import { GET as authorize } from "@/app/auth/website-admin/authorize/route";
import { POST as redeem } from "@/app/api/website-admin/redeem/route";
import { websiteAdminLive } from "@/lib/auth/website-admin";
import { uidSiteSecret } from "@/lib/auth/uid-sites";
import { MemberError } from "@/lib/uid/member-policy";

const host = "wrapauthority.net";
const user = { id: "account-id", fullName: "Paolo", isService: false };
const email = "paolo@tboxstudio.com";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const start = () => authorize(new NextRequest(
  `https://login.10xid.com/auth/website-admin/authorize?host=${host}&challenge=${challenge}`,
  { headers: { host: "login.10xid.com" } },
));
const exchange = (ticket: string, proof = verifier, audience = host) => redeem(new Request(
  "https://login.10xid.com/api/website-admin/redeem",
  { method: "POST", headers: { authorization: `Bearer ${uidSiteSecret(host)}` },
    body: JSON.stringify({ host: audience, ticket, verifier: proof }) },
));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("UID_SITE_KEY", "test-only-not-used-outside-unit-tests");
  vi.stubEnv("UID_OTHER_HOSTS", host);
  vi.stubEnv("UID_SITES", `${host}=${email}`);
  mock.getLoginSession.mockResolvedValue({ user: { id: "auth-id" }, mfaVerifiedAt: new Date(), sessionId: "auth-session" });
  mock.userByAuthUserId.mockResolvedValue(user);
  mock.userById.mockResolvedValue(user);
  mock.authSessionLive.mockResolvedValue(true);
  mock.accountAddresses.mockResolvedValue([email]);
  mock.editableCid.mockResolvedValue({});
});

describe("central website admin sign-in", () => {
  it("asks for 10XiD sign-in and MFA before minting an admin ticket", async () => {
    mock.getLoginSession.mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { id: "auth-id" } });
    for (const path of ["/auth/sign-in", "/auth/mfa"]) {
      const response = await start();
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe(path);
      expect(location.searchParams.get("next")).toContain("/auth/website-admin/authorize?");
    }
    expect(mock.mintTicket).not.toHaveBeenCalled();
  });

  it("requires the right company membership to authorize and recheck", async () => {
    mock.editableCid.mockRejectedValueOnce(new MemberError("Denied."));
    const denied = await start();
    expect(new URL(denied.headers.get("location")!).pathname).toBe("/auth/uid/denied");
    expect(mock.editableCid).toHaveBeenCalledWith("wrapauthority", user.id);
    expect(mock.mintTicket).not.toHaveBeenCalled();
  });

  it("binds the ticket to the configured site and browser proof, then checks session revocation", async () => {
    const response = await start();
    const callback = new URL(response.headers.get("location")!);
    expect(callback.origin).toBe(`https://${host}`);
    expect(callback.pathname).toBe("/api/auth/10xid");
    expect(callback.searchParams.get("state")).toBe(challenge);
    const ticket = callback.searchParams.get("ticket")!;
    const minted = mock.mintTicket.mock.calls[0][0];
    let used = false;
    mock.redeemTicket.mockImplementation(async (hash: Buffer, audience: string) => {
      if (used || !hash.equals(minted.ticketHash) || audience !== minted.audienceHost) return null;
      used = true;
      return minted;
    });
    expect((await exchange(ticket, "w".repeat(43))).status).toBe(400);
    expect((await exchange(ticket, verifier, "example.com")).status).toBe(401);
    const { stamp } = await (await exchange(ticket)).json();
    expect(await websiteAdminLive(host, email, stamp)).toBe(true);
    expect(await websiteAdminLive(host, "someone@tboxstudio.com", stamp)).toBe(false);
    expect((await exchange(ticket)).status).toBe(400);
    mock.editableCid.mockRejectedValueOnce(new MemberError("Removed."));
    expect(await websiteAdminLive(host, email, stamp)).toBe(false);
    mock.authSessionLive.mockResolvedValue(false);
    expect(await websiteAdminLive(host, email, stamp)).toBe(false);
  });
});
