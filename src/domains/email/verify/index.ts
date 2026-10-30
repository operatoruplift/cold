/**
 * Reacher (github.com/reacherhq/check-if-email-exists), the open source email
 * verifier, self-hosted: docker run -p 8080:8080 reacherhq/backend:latest
 */

export type Reachability = "safe" | "risky" | "invalid" | "unknown";

export interface Verifier {
  check(email: string): Promise<Reachability>;
}

/** A Reacher verifier from REACHER_URL (and REACHER_SECRET), or undefined. */
export function reacherFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Verifier | undefined {
  const base = env.REACHER_URL?.trim().replace(/\/+$/, "");
  if (!base) return undefined;
  const secret = env.REACHER_SECRET?.trim();
  return {
    async check(email) {
      try {
        const response = await fetchImpl(`${base}/v0/check_email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(secret ? { "x-reacher-secret": secret } : {}) },
          body: JSON.stringify({ to_email: email }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) return "unknown";
        const json = (await response.json()) as { is_reachable?: string };
        return ["safe", "risky", "invalid", "unknown"].includes(json.is_reachable ?? "") ? (json.is_reachable as Reachability) : "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}
