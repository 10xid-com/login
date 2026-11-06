export default function Loading() {
  return (
    <main className="min-h-dvh bg-ground px-4 py-12" aria-busy="true">
      <div className="mx-auto w-full max-w-2xl">
        <p role="status" className="text-sm text-ink-soft">Loading your work…</p>
      </div>
    </main>
  );
}
