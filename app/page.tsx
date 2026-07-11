import { appName } from "@/lib/i18n/he";

// Phase 0 has no UI by decree — this placeholder is replaced by the
// Exceptions Console in phase 1.
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-semibold text-neutral-400">{appName}</h1>
    </main>
  );
}
