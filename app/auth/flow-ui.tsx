import type { ReactNode } from "react";
import Link from "next/link";
import type { SocialProvider } from "@/lib/auth/auth";
import { signInWithProviderAction } from "./identity-actions";

/** Pieces shared by the sign-in screens, on top of auth-card.tsx. */

const PROVIDER_LABEL: Record<SocialProvider, string> = {
  google: "Continue with Google",
  microsoft: "Continue with Microsoft",
};

export function ProviderButtons({ providers, next }: { providers: SocialProvider[]; next: string }) {
  if (providers.length === 0) return null;
  return (
    <div className="mt-6 border-t border-line-soft pt-5 space-y-2">
      {providers.map((provider) => (
        <form key={provider} action={signInWithProviderAction}>
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="next" value={next} />
          <SecondaryButton>{PROVIDER_LABEL[provider]}</SecondaryButton>
        </form>
      ))}
    </div>
  );
}

export function SecondaryButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="submit"
      className="w-full rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink
                 transition-colors duration-150 hover:bg-sunk focus-visible:outline-2
                 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      {children}
    </button>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="mb-4 rounded-lg border border-line bg-sunk px-3 py-2 text-sm text-ink-soft">
      {children}
    </p>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-brand underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

export function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}
