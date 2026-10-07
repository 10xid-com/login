import type { ReactNode } from "react";

/**
 * The frame every sign-in screen sits in.
 *
 * Follows the conventions already set by the Rotary storefront — a centred
 * card on a soft ground, "Welcome back" as the greeting, one primary action —
 * so the portal reads as part of the same family rather than a bolt-on.
 */
export function AuthCard({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="min-h-dvh bg-ground flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-xs font-semibold tracking-[0.06em] text-brand">
            10XiD
          </div>
        </div>

        <div className="bg-surface border border-line rounded-2xl shadow-card p-6 sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight text-ink text-balance">
            {title}
          </h1>
          {intro ? (
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{intro}</p>
          ) : null}
          <div className="mt-6">{children}</div>
        </div>

        {footer ? (
          <p className="mt-6 text-center text-xs leading-relaxed text-ink-faint">
            {footer}
          </p>
        ) : null}
      </div>
    </main>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-3 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad"
    >
      {children}
    </p>
  );
}

export function SubmitButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="submit"
      className="mt-4 w-full rounded-lg bg-brand-surface px-4 py-2.5 text-sm font-semibold
                 text-brand-on-surface transition-colors duration-150 hover:bg-brand-surface-hover
                 focus-visible:outline-2 focus-visible:outline-offset-2
                 focus-visible:outline-brand"
    >
      {children}
    </button>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink " +
  "placeholder:text-ink-faint transition-colors duration-150 " +
  "focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand/30";

export const labelClass =
  "block text-xs font-semibold uppercase tracking-wider text-ink-faint mb-1.5";
