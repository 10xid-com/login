import { afterEach, describe, expect, test, vi } from "vitest";
import { isUidSiteCaller, mayOpenUid, parseOtherHosts, parseUidSites, uidSiteSecret } from "@/lib/auth/uid-sites";

/**
 * UID_SITES and UID_SITE_KEY: which UiD pages sign in through the login host,
 * who may open each, and the secret each one's server proves itself with.
 */

const KEY = "a-test-only-uid-site-key-0123456789abcdef";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseUidSites", () => {
  test("host=address|address pairs, comma-separated, in lower case", () => {
    const sites = parseUidSites(
      " UID-Rana.10xid.com = Samay@TboxStudio.com | paolo@tboxstudio.com ,uid-bypaolo.10xid.com=paolo@tboxstudio.com",
      "login.10xid.com",
      "app.10xid.com",
    );
    expect(Object.fromEntries([...sites].map(([h, p]) => [h, [...p]]))).toEqual({
      "uid-rana.10xid.com": ["samay@tboxstudio.com", "paolo@tboxstudio.com"],
      "uid-bypaolo.10xid.com": ["paolo@tboxstudio.com"],
    });
  });

  test("only a 10xid.com subdomain that is neither the login host nor the portal's", () => {
    for (const entry of [
      "evil.test=a@b.co",
      "10xid.com.evil.test=a@b.co",
      "uid.10xid.com.evil.test=a@b.co",
      "notes10xid.com=a@b.co",
      "login.10xid.com=a@b.co",
      "app.10xid.com=a@b.co",
      "uid-a.10xid.com:8443=a@b.co",
      "https://uid-a.10xid.com=a@b.co",
      "uid-a.10xid.com/x=a@b.co",
      "uid-a.10xid.com=",
      "uid-a.10xid.com=not-an-address",
      "=a@b.co",
      "nonsense",
    ]) {
      expect(parseUidSites(entry, "login.10xid.com", "app.10xid.com").size, entry).toBe(0);
    }
  });
});

describe("sites outside 10xid.com", () => {
  test("are taken only when UID_OTHER_HOSTS names them as well", () => {
    const entry = "www.brandingcentres.com=paolo@tboxstudio.com,wrapauthority.net=paolo@tboxstudio.com";
    expect(parseUidSites(entry, "login.10xid.com", "app.10xid.com").size).toBe(0);
    const sites = parseUidSites(entry, "login.10xid.com", "app.10xid.com", parseOtherHosts(" WWW.BrandingCentres.com ,wrapauthority.net"));
    expect([...sites.keys()]).toEqual(["www.brandingcentres.com", "wrapauthority.net"]);
    expect(parseUidSites(entry, "", "", parseOtherHosts("brandingcentres.com")).size).toBe(0);
  });

  test("UID_OTHER_HOSTS takes bare hosts only, and never a 10xid.com one", () => {
    expect([...parseOtherHosts("https://evil.test,evil.test:8443,evil.test/x,login.10xid.com,10xid.com,,ok.test")]).toEqual(["ok.test"]);
  });
});

describe("the per-UiD secret", () => {
  test("comes from UID_SITE_KEY and the host, differs per host, and needs a long enough key", () => {
    const a = uidSiteSecret("uid-a.10xid.com", KEY);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(uidSiteSecret("UID-A.10xid.com", KEY)).toBe(a);
    expect(uidSiteSecret("uid-b.10xid.com", KEY)).not.toBe(a);
    expect(uidSiteSecret("uid-a.10xid.com", "short")).toBeNull();
    expect(uidSiteSecret("uid-a.10xid.com", undefined)).toBeNull();
  });

  test("a caller is that UiD only with its own secret, as a Bearer token", () => {
    vi.stubEnv("UID_SITES", "uid-a.10xid.com=a@b.co,uid-b.10xid.com=a@b.co");
    vi.stubEnv("UID_SITE_KEY", KEY);
    const secret = uidSiteSecret("uid-a.10xid.com")!;
    expect(isUidSiteCaller("uid-a.10xid.com", `Bearer ${secret}`)).toBe(true);
    expect(isUidSiteCaller("uid-b.10xid.com", `Bearer ${secret}`)).toBe(false);
    expect(isUidSiteCaller("uid-c.10xid.com", `Bearer ${uidSiteSecret("uid-c.10xid.com")}`)).toBe(false);
    expect(isUidSiteCaller("uid-a.10xid.com", secret)).toBe(false);
    expect(isUidSiteCaller("uid-a.10xid.com", `Bearer ${secret}x`)).toBe(false);
    expect(isUidSiteCaller("uid-a.10xid.com", null)).toBe(false);
    vi.stubEnv("UID_SITE_KEY", "");
    expect(isUidSiteCaller("uid-a.10xid.com", `Bearer ${secret}`)).toBe(false);
  });

  test("who may open a UiD is read when asked", () => {
    vi.stubEnv("UID_SITES", "uid-a.10xid.com=a@b.co|c@d.co");
    expect(mayOpenUid("uid-a.10xid.com", "C@D.co")).toBe(true);
    expect(mayOpenUid("uid-a.10xid.com", "e@f.co")).toBe(false);
    expect(mayOpenUid("uid-b.10xid.com", "a@b.co")).toBe(false);
  });
});
