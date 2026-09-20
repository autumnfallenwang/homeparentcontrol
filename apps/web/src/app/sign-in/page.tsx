"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Banner, Button, Card, Field, inputClass } from "../../components/ui.js";
import { currentSession, signIn, signUp } from "../../lib/auth-client.js";

/**
 * `/sign-in` — the only door.
 *
 * ⚠️ **A parent's door, and nobody else's.** §5.8: the UI has "no
 * child-facing surface of any kind (no login, no status page, no
 * time-remaining widget, no request button, no notification inbox)". There
 * is no second form on this page and no route to add one.
 *
 * The sign-up half exists because the first parent has to get in somehow —
 * `bootstrap.ts` claims the first household for whoever signs up first. It
 * is not registration in the usual sense: a second household is not a thing
 * this product has.
 */
export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in? Nothing to do here.
  useEffect(() => {
    void currentSession().then((session) => {
      if (session) router.replace("/");
    });
  }, [router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") {
        await signIn(email, password);
      } else {
        await signUp(email, password, name || "Parent");
      }
      router.replace("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">homeparentcontrol</h1>
      <Card>
        <form onSubmit={submit} className="space-y-3">
          {mode === "up" ? (
            <Field label="Your name">
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
              />
            </Field>
          ) : null}
          <Field label="Email">
            <input
              type="email"
              className={inputClass}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              className={inputClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              required
            />
          </Field>

          {error ? <Banner tone="alarm" title={error} /> : null}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button type="submit" variant="primary" disabled={busy}>
              {mode === "in" ? "Sign in" : "Create the first account"}
            </Button>
            <Button variant="quiet" onClick={() => setMode(mode === "in" ? "up" : "in")}>
              {mode === "in" ? "First time here?" : "I already have an account"}
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}
