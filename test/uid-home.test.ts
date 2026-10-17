import { afterEach, describe, expect, test, vi } from "vitest";
import { parseUidHomes, uidHomeFor } from "@/lib/auth/uid-home";

/**
 * UID_HOMES: who ends signing in at a UiD of their own, and the guard that
 * keeps it from ever being a redirect to anywhere else.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseUidHomes", () => {
  test("reads address=https pairs, comma-separated, addresses in lower case", () => {
    const homes = parseUidHomes(
      " Paolo@10XiD.com = https://uid-bypaolo.10xid.com/v3/ ,rana@example.com=https://uid-rana.10xid.com",
      "login.10xid.com",
    );
    expect(Object.fromEntries(homes)).toEqual({
      "paolo@10xid.com": "https://uid-bypaolo.10xid.com/v3/",
      "rana@example.com": "https://uid-rana.10xid.com/",
    });
  });

  test("takes only https on a 10xid.com subdomain that is not the login host", () => {
    const bad = [
      "a@b.co=http://uid-a.10xid.com/",
      "a@b.co=https://evil.test/",
      "a@b.co=https://10xid.com.evil.test/",
      "a@b.co=https://uid-a.10xid.com.evil.test/",
      "a@b.co=https://notes10xid.com/",
      "a@b.co=https://login.10xid.com/",
      "a@b.co=https://user:pass@uid-a.10xid.com/",
      "a@b.co=https://uid-a.10xid.com:8443/",
      "a@b.co=javascript:alert(1)",
      "a@b.co=//uid-a.10xid.com/",
      "a@b.co=",
      "not-an-address=https://uid-a.10xid.com/",
      "=https://uid-a.10xid.com/",
      "nonsense",
    ];
    for (const pair of bad) expect(parseUidHomes(pair, "login.10xid.com").size, pair).toBe(0);
  });

  test("a bad pair is dropped without losing the good ones", () => {
    const homes = parseUidHomes("a@b.co=https://evil.test/,c@d.co=https://uid-c.10xid.com/", "login.10xid.com");
    expect([...homes.keys()]).toEqual(["c@d.co"]);
  });

  test("nothing set means nobody", () => {
    expect(parseUidHomes(undefined).size).toBe(0);
    expect(parseUidHomes("").size).toBe(0);
  });
});

describe("uidHomeFor", () => {
  test("reads UID_HOMES when asked, matching the address in any case", () => {
    vi.stubEnv("PRIMARY_HOST", "login.10xid.com");
    vi.stubEnv("UID_HOMES", "paolo@10xid.com=https://uid-bypaolo.10xid.com/v3/");
    expect(uidHomeFor("Paolo@10XiD.com")).toBe("https://uid-bypaolo.10xid.com/v3/");
    expect(uidHomeFor("someone@else.com")).toBeNull();
  });

  test("never sends sign-in back to the login host itself", () => {
    vi.stubEnv("PRIMARY_HOST", "login.10xid.com");
    vi.stubEnv("UID_HOMES", "a@b.co=https://login.10xid.com/auth/sign-in");
    expect(uidHomeFor("a@b.co")).toBeNull();
  });
});
