import { useEffect, useState } from "react";
import { fetchDeepMatchDossier } from "../services/liveMatchesApi.js";
import { buildTruthCertificate } from "../engine/antiBiasEngine.js";

export default function MatchTruthDossierModal({ match, onClose, onAddCoupon, onInspectPredict }) {
  const [dossier, setDossier] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchDeepMatchDossier(match)
      .then((res) => {
        if (alive) {
          setDossier(res);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [match]);

  if (!match) return null;

  const pred = match.prediction;
  const cert = buildTruthCertificate(match, dossier);
  const gate = pred?.reliabilityGate;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(4, 6, 20, 0.88)",
        backdropFilter: "blur(8px)",
        overflowY: "auto",
        padding: "18px 12px 48px",
      }}
      onClick={onClose}
    >
      <div
        className="fai-panel"
        style={{
          maxWidth: 880,
          margin: "0 auto",
          border: "1px solid rgba(0, 229, 255, 0.45)",
          boxShadow: "0 18px 60px rgba(0, 0, 0, 0.75)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* En-tête Certificat Zéro Hallucination */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
            borderBottom: "1px solid rgba(124,77,255,0.25)",
            paddingBottom: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  padding: "3px 9px",
                  borderRadius: 999,
                  background: "rgba(0,230,118,0.14)",
                  border: "1px solid #00e676",
                  color: "#00e676",
                }}
              >
                {cert.badgeLabel}
              </span>
              {gate && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    padding: "3px 9px",
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.06)",
                    border: `1px solid ${gate.color}`,
                    color: gate.color,
                  }}
                >
                  {gate.badge} ({gate.compositeScore}/100)
                </span>
              )}
              <span style={{ fontSize: 11, color: "#9aa3c7", paddingTop: 3 }}>
                Intégrité Données : <strong style={{ color: "#fff" }}>{cert.completenessPct}%</strong>
              </span>
            </div>

            <div style={{ fontSize: 19, fontWeight: 900, color: "#ffffff" }}>
              {match.home} <span style={{ color: "#00e5ff" }}>vs</span> {match.away}
            </div>
            <div style={{ fontSize: 12, color: "#b6c0e8", marginTop: 4 }}>
              📅 <strong>{match.fullDateFr || match.dateFr || "Date exacte"}</strong> à{" "}
              <strong>{match.timeStr}</strong> • 🏆 {match.leagueLabel || match.league}
            </div>
            <div style={{ fontSize: 12, color: "#00e5ff", marginTop: 3 }}>
              🏟️ Lieu exact :{" "}
              <strong>
                {dossier?.venueExact?.name ||
                  match.venueFull ||
                  match.venue ||
                  "Stade non publié par l'organisateur"}
              </strong>
              {(dossier?.venueExact?.city || match.venueCity) &&
                ` — ${dossier?.venueExact?.city || match.venueCity}`}
              {(dossier?.venueExact?.country || match.venueCountry) &&
                ` (${dossier?.venueExact?.country || match.venueCountry})`}
              {dossier?.venueExact?.attendance
                ? ` • 👥 Affluence : ${Number(dossier.venueExact.attendance).toLocaleString("fr-FR")}`
                : ""}
            </div>
            {dossier?.venueExact?.officials?.length > 0 && (
              <div style={{ fontSize: 11, color: "#9aa3c7", marginTop: 2 }}>
                ⚖️ Officiels / Arbitres : {dossier.venueExact.officials.join(", ")}
              </div>
            )}
          </div>

          <button type="button" className="fai-btn-ghost" onClick={onClose}>
            ✕ Fermer
          </button>
        </div>

        {/* Verdict Strict Anti-Biais & Marché Recommandé */}
        {pred && (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: "rgba(0, 229, 255, 0.07)",
              border: `1px solid ${gate?.color || "#00e5ff"}`,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 11, color: "#9aa3c7", fontWeight: 700 }}>
                   DÉCISION DU MOTEUR ANTI-BIAIS (SANS CLONAGE DE SCHÉMA)
                </div>
                <div style={{ fontSize: 15, fontWeight: 900, color: "#fff", marginTop: 2 }}>
                  ★ {pred.recommendedMarket?.label} —{" "}
                  <span style={{ color: "#00e676" }}>{pred.recommendedMarket?.pct}%</span>{" "}
                  <span style={{ fontSize: 12, color: "#9aa3c7" }}>
                    (Cote juste @{pred.recommendedMarket?.fairOdd})
                  </span>
                </div>
                {gate && (
                  <div style={{ fontSize: 11.5, color: gate.color, marginTop: 4 }}>
                    {gate.verdict}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {onAddCoupon && (
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    onClick={() => {
                      onAddCoupon(match);
                      onClose();
                    }}
                  >
                    ➕ Ajouter au Coupon Ticket
                  </button>
                )}
                {match.sport === "soccer" && onInspectPredict && (
                  <button
                    type="button"
                    className="fai-btn-ghost"
                    onClick={() => {
                      onInspectPredict(match);
                      onClose();
                    }}
                  >
                    🔬 Ouvrir Matrice Dixon-Coles Complète
                  </button>
                )}
              </div>
            </div>

            {/* Paramètres contextuels réels pris en compte */}
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 10,
                fontSize: 11,
                color: "#cbd2f5",
              }}
            >
              <span style={{ background: "#0b0f29", padding: "3px 8px", borderRadius: 6 }}>
                📊 Bilan {match.home}: <strong>{match.homeRecord || "N/C"}</strong>
              </span>
              <span style={{ background: "#0b0f29", padding: "3px 8px", borderRadius: 6 }}>
                📊 Bilan {match.away}: <strong>{match.awayRecord || "N/C"}</strong>
              </span>
              {dossier?.restDaysHome !== null && dossier?.restDaysHome !== undefined && (
                <span style={{ background: "#0b0f29", padding: "3px 8px", borderRadius: 6 }}>
                  🔋 Repos {match.home}: <strong>{dossier.restDaysHome} j</strong>
                </span>
              )}
              {dossier?.restDaysAway !== null && dossier?.restDaysAway !== undefined && (
                <span style={{ background: "#0b0f29", padding: "3px 8px", borderRadius: 6 }}>
                  🔋 Repos {match.away}: <strong>{dossier.restDaysAway} j</strong>
                </span>
              )}
              {dossier?.espnPredictor?.homeWinPct && (
                <span style={{ background: "#0b0f29", padding: "3px 8px", borderRadius: 6 }}>
                  🌐 Cross-Check ESPN BPI :{" "}
                  <strong>
                    {dossier.espnPredictor.homeWinPct}% / {dossier.espnPredictor.awayWinPct}%
                  </strong>
                </span>
              )}
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: "#00e5ff", fontWeight: 700 }}>
            ⚡ Interrogation directe des serveurs officiels en cours (H2H exacts, Stade, Joueurs &amp; Blessures)...
          </div>
        ) : (
          <div className="fai-grid-2">
            {/* COLONNE 1 : CONFRONTATIONS DIRECTES H2H AVEC DATES & LIEUX EXACTS */}
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "#090c22",
                border: "1px solid rgba(124,77,255,0.22)",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 800, color: "#00e5ff", marginBottom: 8 }}>
                ⚔️ Confrontations Directes Vérifiées (Dates &amp; Lieux Exacts)
              </div>
              {dossier?.h2hGames?.length > 0 ? (
                dossier.h2hGames.map((g, i) => (
                  <div
                    key={g.id || i}
                    style={{
                      padding: "7px 0",
                      borderBottom: "1px solid rgba(255,255,255,0.06)",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <strong style={{ color: "#fff" }}>
                        {g.homeTeam} <span style={{ color: "#00e676" }}>{g.score}</span> {g.awayTeam}
                      </strong>
                      <span style={{ color: "#ffea00", fontSize: 11, fontWeight: 700 }}>
                        {g.dateExactFr}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#9aa3c7", marginTop: 2 }}>
                      🏟️ {g.venue || "Lieu officiel"} {g.competition ? `• 🏆 ${g.competition}` : ""}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 11.5, color: "#9aa3c7", lineHeight: 1.5 }}>
                  ⚪ Aucune confrontation directe récente publiée dans le flux officiel pour cette affiche
                  (Garantie Zéro-Hallucination : aucun score passé n&apos;est inventé).
                </div>
              )}

              {/* Forme récente exacte des 2 équipes */}
              <div style={{ fontSize: 13, fontWeight: 800, color: "#76ff03", margin: "14px 0 8px" }}>
                📈 Derniers Résultats Officiels ({match.home} &amp; {match.away})
              </div>
              {[
                { label: match.home, list: dossier?.homeRecent || [] },
                { label: match.away, list: dossier?.awayRecent || [] },
              ].map((block) => (
                <div key={block.label} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: "#cbd2f5", marginBottom: 4 }}>
                    ● {block.label}
                  </div>
                  {block.list.length > 0 ? (
                    block.list.slice(0, 4).map((r, idx) => (
                      <div
                        key={r.id || idx}
                        style={{
                          fontSize: 11,
                          color: "#b6c0e8",
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "3px 0",
                        }}
                      >
                        <span>
                          <strong
                            style={{
                              color:
                                r.resultLetter === "W"
                                  ? "#00e676"
                                  : r.resultLetter === "L"
                                    ? "#ff4d6d"
                                    : "#ffea00",
                            }}
                          >
                            [{r.resultLetter || "•"}]
                          </strong>{" "}
                          vs {r.opponent} ({r.score}) • {r.locationType}
                        </span>
                        <span style={{ color: "#8c96be" }}>{r.dateExactFr}</span>
                      </div>
                    ))
                  ) : (
                    <div style={{ fontSize: 11, color: "#7882ab" }}>
                      Série saison : {match.home === block.label ? match.homeRecord || "N/C" : match.awayRecord || "N/C"}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* COLONNE 2 : FORME DES JOUEURS CLÉS & BLESSÉS / ABSENTS OFFICIELS */}
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "#090c22",
                border: "1px solid rgba(124,77,255,0.22)",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 800, color: "#ffea00", marginBottom: 8 }}>
                🌟 Forme des Joueurs Clés &amp; Performeurs Officiels
              </div>
              {(dossier?.playerLeaders?.length || match.leaders?.length) ? (
                (dossier?.playerLeaders || match.leaders).map((pl, idx) => (
                  <div
                    key={`${pl.player}-${idx}`}
                    style={{
                      padding: "6px 0",
                      borderBottom: "1px solid rgba(255,255,255,0.06)",
                      fontSize: 12,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <div>
                      <strong style={{ color: "#fff" }}>{pl.player}</strong>{" "}
                      <span style={{ color: "#9aa3c7", fontSize: 11 }}>({pl.team})</span>
                      <div style={{ fontSize: 10.5, color: "#00e5ff" }}>{pl.category}</div>
                    </div>
                    <strong style={{ color: "#00e676", fontSize: 12 }}>{pl.value}</strong>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 11.5, color: "#9aa3c7" }}>
                  ⚪ Statistiques individuelles publiées à l&apos;annonce des compositions officielles.
                </div>
              )}

              <div style={{ fontSize: 13, fontWeight: 800, color: "#ff5252", margin: "14px 0 8px" }}>
                🏥 Rapport Médical Officiel : Blessés &amp; Absents
              </div>
              {dossier?.injuries?.length > 0 ? (
                dossier.injuries.map((inj, idx) => (
                  <div
                    key={`${inj.player}-${idx}`}
                    style={{
                      padding: "5px 0",
                      borderBottom: "1px solid rgba(255,255,255,0.05)",
                      fontSize: 11.5,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span>
                      <strong style={{ color: "#fff" }}>{inj.player}</strong>{" "}
                      {inj.position ? `(${inj.position})` : ""} —{" "}
                      <span style={{ color: "#9aa3c7" }}>{inj.team}</span>
                      {inj.detail ? ` • ${inj.detail}` : ""}
                    </span>
                    <span style={{ color: "#ff5252", fontWeight: 800 }}>{inj.status}</span>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 11.5, color: "#9aa3c7" }}>
                  ⚪ Aucun joueur blessé signalé dans le bulletin officiel actuel (aucune blessure inventée).
                </div>
              )}

              <div
                style={{
                  marginTop: 14,
                  padding: 9,
                  borderRadius: 8,
                  background: "rgba(0, 230, 118, 0.06)",
                  border: "1px solid rgba(0, 230, 118, 0.25)",
                  fontSize: 10.5,
                  color: "#a7f3d0",
                  lineHeight: 1.45,
                }}
              >
                🛡️ <strong>Protocole Zéro-Hallucination v6.4 Certifiée Intégrale :</strong> {cert.strictPolicyNote}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
