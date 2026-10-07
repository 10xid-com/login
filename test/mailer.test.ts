import { describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.PRIMARY_HOST = "login.10xid.com";
  process.env.SESSION_COOKIE_SECURE = "true";
});

const { codeMessage } = await import("@/lib/auth/mailer");

/**
 * The emailed code links to the page it is typed into — and never carries
 * the code in the link, which a mail scanner would follow on arrival.
 */
describe("code emails", () => {
  const message = (purpose: "sign-in" | "forget-password", to = "Samay+test@TBoxStudio.com") =>
    codeMessage({ to, code: "386254", purpose, expiresInMinutes: 10 });

  test("a sign-in code links to the code page with the address filled in", () => {
    const { subject, text } = message("sign-in");
    expect(subject).toBe("386254 is your 10XiD sign-in code");
    expect(text).toContain(
      "Enter it here: https://login.10xid.com/auth/sign-in/code?email=Samay%2Btest%40TBoxStudio.com",
    );
  });

  test("a reset code links to the reset page", () => {
    expect(message("forget-password").text).toContain(
      "https://login.10xid.com/auth/reset-password?email=",
    );
  });

  test("the link never contains the code", () => {
    for (const purpose of ["sign-in", "forget-password"] as const) {
      const link = message(purpose).text.match(/https:\/\/\S+/)![0];
      expect(link).not.toContain("386254");
    }
  });

  test("the HTML version has the code and a button to the same page, and escapes the address", () => {
    const { html } = codeMessage({ to: 'a"<b>@test.invalid', code: "386254", purpose: "sign-in", expiresInMinutes: 10 });
    expect(html).toContain(">386254<");
    expect(html).toContain('href="https://login.10xid.com/auth/sign-in/code?email=a%22%3Cb%3E%40test.invalid"');
    expect(html).not.toContain("<b>");
    const href = html.match(/href="([^"]+)"/)![1]!;
    expect(href).not.toContain("386254");
  });
});
