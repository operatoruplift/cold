import { KeyRound, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { SessionResponse } from "../../domains/web/types";
import { useSession } from "../app/session";
import { api, ApiError } from "../lib/api";
import { Button, ErrorNotice, Field } from "../ui/kit";

/** The brand side of the sign-in screen: the logo, the line, the ridges. */
function Art() {
  return (
    <div className="auth-art" aria-hidden="true">
      <img className="logo" src="/brand/cold-logo.svg" alt="" />
      <div>
        <h1>
          Break
          <br />
          the <span>ice.</span>
        </h1>
        <p>Cold DMs, cold emails, cold calls and prospect research, in one place that only you can open.</p>
      </div>
      <img className="ridges" src="/brand/ridges.svg" alt="" />
    </div>
  );
}

function clearSetupParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has("setup")) return;
  url.searchParams.delete("setup");
  history.replaceState({}, "", url.pathname + url.search);
}

/** Sign in, or (the very first time) create the owner login with the setup code the server printed. */
export function AuthScreen() {
  const { session, accept } = useSession();
  const setup = !!session?.setupRequired;
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("setup") ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (setup && password !== confirm) {
      setError(new ApiError(400, "The two passwords are not the same."));
      return;
    }
    setBusy(true);
    try {
      const next = await api<SessionResponse>(setup ? "/api/session/setup" : "/api/session/login", { method: "POST", body: setup ? { code, email, password } : { email, password } });
      clearSetupParam();
      accept(next);
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <Art />
      <div className="auth-side">
        <form className="auth-card" onSubmit={submit}>
          <h2>{setup ? "Create your login" : "Welcome back"}</h2>
          <p className="auth-sub">
            {setup
              ? "COLD has one owner: you. Pick the email and password you'll sign in with, on this computer and on any device you install COLD on."
              : "Sign in to your COLD workspace."}
          </p>
          <ErrorNotice error={error} title={setup ? "Not created" : "Not signed in"} />
          <div style={{ marginTop: error ? 14 : 0 }}>
            {setup && (
              <Field label="Setup code" hint="Printed in the terminal, or your host's logs, when COLD started.">
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX" required />
              </Field>
            )}
            <Field label="Email">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus={!setup} />
            </Field>
            <Field label="Password" hint={setup ? "At least 12 characters. A short sentence works well." : undefined}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} required minLength={setup ? 12 : undefined} />
            </Field>
            {setup && (
              <Field label="Password again">
                <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </Field>
            )}
          </div>
          <Button type="submit" variant="primary" size="lg" block loading={busy} icon={setup ? KeyRound : LogIn}>
            {setup ? "Create login and open COLD" : "Sign in"}
          </Button>
          <p className="auth-foot">
            {setup ? "Forgot it later? Reset it on the server with bun run cold owner." : "Forgot your password? Reset it where COLD runs: bun run cold owner."}
          </p>
          <p className="auth-foot">
            <a href="/">Back to the COLD site</a>
          </p>
        </form>
      </div>
    </div>
  );
}
