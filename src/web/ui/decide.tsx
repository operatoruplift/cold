import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, Quote } from "lucide-react";
import type { Decision, Dossier, Tier } from "../../domains/decide";
import type { Action } from "../../domains/decide/model";
import { ACTION_LABEL, ACTION_TONE, ANGLE_LABEL, FACTOR_LABEL, OBJECTION_LABEL, pct, PROVIDER_LABEL, TIER_TONE, TONE_LABEL } from "../lib/decide";
import { ago } from "../lib/format";
import { Pill } from "./kit";

/** A score out of 100 with its tier: the bar, the number, the letter. */
export function ScoreCell({ score, tier, compact }: { score: number; tier: Tier; compact?: boolean }) {
  return (
    <span className="score-cell" title={`Score ${score} of 100, tier ${tier}`}>
      {!compact && (
        <span className="bar" style={{ minWidth: 56 }}>
          <span style={{ width: `${score}%` }} />
        </span>
      )}
      <b>{score}</b>
      <Pill tone={TIER_TONE[tier]}>{tier}</Pill>
    </span>
  );
}

export function ActionPill({ action, review }: { action: Action; review?: boolean }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      <Pill tone={ACTION_TONE[action]}>{ACTION_LABEL[action]}</Pill>
      {review && (
        <Pill tone="amber" icon={AlertTriangle} title="The engine isn't sure: check before acting.">
          Check
        </Pill>
      )}
    </span>
  );
}

const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/** Probabilities as a row of chips, the most likely first. */
function Spread({ probabilities, label }: { probabilities: Record<string, number>; label: (k: string) => string }) {
  const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return (
    <span className="row wrap" style={{ gap: 4 }}>
      {sorted.map(([k, p], i) => (
        <Pill key={k} tone={i === 0 ? "blue" : "gray"}>
          {label(k)} {pct(p)}
        </Pill>
      ))}
    </span>
  );
}

/** Everything behind a decision: the factors and why, the style, the diligence with its evidence. */
export function DecisionDetail({ decision, dossier, dossierAt }: { decision?: Decision; dossier?: Dossier; dossierAt?: string }) {
  return (
    <div className="decision-detail">
      {decision ? (
        <div className="stack" style={{ gap: 12 }}>
          {decision.review && (
            <div className="notice amber" role="status">
              <AlertTriangle size={16} />
              <div className="notice-body">
                <div className="notice-title">Check this one before acting</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {decision.reviewReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div>
            <div className="section-label">Why this score</div>
            <div className="factors">
              {(Object.keys(FACTOR_LABEL) as Array<keyof typeof FACTOR_LABEL>).map((f) => {
                const factor = decision.factors[f];
                return (
                  <div key={f} className="factor">
                    <span className="factor-name">{FACTOR_LABEL[f]}</span>
                    <span className="bar">
                      <span style={{ width: pct(factor.value) }} />
                    </span>
                    <span className="factor-value">{pct(factor.value)}</span>
                    <span className="factor-reason">{factor.reason ?? ""}</span>
                  </div>
                );
              })}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Score = fit × (40% need + 20% timing + 15% decision-maker + 10% can pay + 15% reachable).
            </div>
          </div>
          <div className="detail-grid">
            <div>
              <div className="section-label">Tone they're most likely to answer</div>
              <Spread probabilities={decision.style.tones} label={(k) => TONE_LABEL[k as keyof typeof TONE_LABEL] ?? k} />
            </div>
            <div>
              <div className="section-label">Best way to open</div>
              <Spread probabilities={decision.style.angles} label={(k) => ANGLE_LABEL[k as keyof typeof ANGLE_LABEL] ?? k} />
            </div>
            <div>
              <div className="section-label">What may stop them</div>
              <span>{OBJECTION_LABEL[decision.objection.choice]}</span>
            </div>
            <div>
              <div className="section-label">Reach them by</div>
              <span>{decision.channel.choice ?? "No channel yet"}</span>
              {decision.channel.available.length > 1 && <span className="text-3"> (of {decision.channel.available.join(", ")})</span>}
            </div>
          </div>
          <div className="hint">
            {PROVIDER_LABEL[decision.provider]} ({decision.model}) decided {ago(decision.decidedAt)}, from {decision.evidence === "diligence" ? "diligence" : decision.evidence === "research" ? "research" : "the list alone"}. Suggested next step: {ACTION_LABEL[decision.suggested]}, {pct(decision.confidence)} sure.
          </div>
        </div>
      ) : (
        <p className="text-2">Not scored yet.</p>
      )}
      {dossier && (
        <div className="stack" style={{ gap: 12, marginTop: 16 }}>
          <div>
            <div className="section-label">Diligence {dossierAt ? `· ${ago(dossierAt)}` : ""}</div>
            <p>{dossier.summary}</p>
          </div>
          {dossier.needs.length > 0 && (
            <div>
              <div className="section-label">What they need</div>
              <div className="stack" style={{ gap: 8 }}>
                {dossier.needs.map((n) => (
                  <div key={n.need} className="need">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className="strong">{n.need}</span>
                      <Pill tone={n.strength === "strong" ? "green" : n.strength === "moderate" ? "blue" : "gray"}>{n.strength}</Pill>
                      {n.confirmed ? (
                        <Pill tone="green" icon={CheckCircle2} title="The quote is on the page it names.">
                          Quote checked
                        </Pill>
                      ) : (
                        <Pill tone="amber" icon={CircleHelp} title="COLD could not find these exact words on the page.">
                          Quote not found
                        </Pill>
                      )}
                    </div>
                    {n.evidence && (
                      <div className="quote">
                        <Quote size={12} /> {n.evidence}{" "}
                        {/^https?:/.test(n.source) ? (
                          <a href={n.source} target="_blank" rel="noopener noreferrer">
                            {host(n.source)}
                          </a>
                        ) : (
                          <span className="text-3">({n.source})</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="detail-grid">
            {dossier.triggers.length > 0 && (
              <div>
                <div className="section-label">What just happened</div>
                <ul className="plain">
                  {dossier.triggers.map((t) => (
                    <li key={t.sentence}>
                      {t.sentence} {t.when && <span className="text-3">({t.when})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {dossier.unknowns.length > 0 && (
              <div>
                <div className="section-label">Ask on the first call</div>
                <ul className="plain">
                  {dossier.unknowns.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
            {dossier.risks.length > 0 && (
              <div>
                <div className="section-label">Watch out</div>
                <ul className="plain">
                  {dossier.risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
            {(dossier.people.length > 0 || dossier.size || dossier.voice || dossier.tools.length > 0) && (
              <div>
                <div className="section-label">About them</div>
                <ul className="plain">
                  {dossier.people.map((p) => (
                    <li key={p.name}>
                      {p.name}
                      {p.title ? `, ${p.title}` : ""}
                    </li>
                  ))}
                  {dossier.size && <li>Size: {dossier.size}</li>}
                  {dossier.voice && <li>How they write: {dossier.voice}</li>}
                  {dossier.tools.length > 0 && <li>Uses: {dossier.tools.join(", ")}</li>}
                </ul>
              </div>
            )}
          </div>
          {dossier.pages.length > 0 && (
            <div className="sources">
              {dossier.pages.slice(0, 8).map((p) => (
                <a key={p.url} href={p.url} target="_blank" rel="noopener noreferrer" title={p.url}>
                  <ExternalLink size={11} /> {host(p.url)}
                </a>
              ))}
            </div>
          )}
          {dossier.skipped.length > 0 && <div className="hint">Not read: {dossier.skipped.map((s) => `${host(s.url)} (${s.reason})`).join("; ")}</div>}
          <div className="hint">Read by {PROVIDER_LABEL[dossier.provider]}. Every need points at the words that show it; check them before you rely on them.</div>
        </div>
      )}
    </div>
  );
}
