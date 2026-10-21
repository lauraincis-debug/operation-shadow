import { useState, useMemo } from "react";
import { TOURNAMENT_PRESETS, simulateKnockoutTournament } from "../engine/tournamentSimulator.js";

export default function TournamentTab({ modelState, onAddOutrightToCoupon }) {
  const [presetId, setPresetId] = useState("can");
  const [pairs, setPairs] = useState(TOURNAMENT_PRESETS.can.roundOf16);
  const [simSeed, setSimSeed] = useState(1);

  const selectPreset = (id) => {
    setPresetId(id);
    setPairs(TOURNAMENT_PRESETS[id].roundOf16.map((p) => [...p]));
    setSimSeed((s) => s + 1);
  };

  const simResult = useMemo(() => {
    return simulateKnockoutTournament(
      pairs,
      TOURNAMENT_PRESETS[presetId]?.league || "international",
      modelState,
      10000
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs, presetId, modelState, simSeed]);

  const topWinner = simResult.leaderboard[0];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* En-tête + Choix Compétition */}
      <div className="fai-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>
              🏆 Simulateur 10 000× de Phase Finale (CAN • Champions League • Mondial)
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "#8e98c2" }}>
              Simulation Monte-Carlo intégrale Huitièmes ➔ Quarts ➔ Demies ➔ Finale (90&apos; + Prolongations + Tirs au but).
            </p>
          </div>
          <button
            type="button"
            className="fai-btn-secondary"
            onClick={() => setSimSeed((s) => s + 1)}
          >
            🎲 Relancer 10 000 Simulations
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          {Object.values(TOURNAMENT_PRESETS).map((pr) => (
            <button
              key={pr.id}
              type="button"
              className={presetId === pr.id ? "fai-btn-secondary" : "fai-btn-ghost"}
              onClick={() => selectPreset(pr.id)}
            >
              {pr.title}
            </button>
          ))}
        </div>

        {/* Bannière Champion n°1 projeté */}
        {topWinner && (
          <div
            style={{
              marginTop: 16,
              background: "linear-gradient(135deg, rgba(251,191,36,0.16), rgba(0,229,255,0.12))",
              border: "1px solid rgba(251,191,36,0.45)",
              borderRadius: 14,
              padding: "14px 18px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 11, fontWeight: 900, color: "#fbbf24" }}>
                👑 FAVORI N°1 AU SACRE SUR 10 000 TOURNOIS SIMULÉS
              </div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", marginTop: 2 }}>
                🏆 {topWinner.team} — {topWinner.championPct}% de chances de victoire finale
              </div>
              <div style={{ fontSize: 12, color: "#cbd5e1", marginTop: 2 }}>
                Finale probable :{" "}
                <strong>
                  {simResult.bracket.final?.teamA} vs {simResult.bracket.final?.teamB}
                </strong>{" "}
                • Cote juste Vainqueur : <strong>@{topWinner.fairOutrightOdd.toFixed(2)}</strong>
              </div>
            </div>
            {onAddOutrightToCoupon && (
              <button
                type="button"
                className="fai-btn-secondary"
                onClick={() => {
                  const pct = Math.max(3, Math.round(topWinner.championPct));
                  onAddOutrightToCoupon({
                    sport: "soccer",
                    home: topWinner.team,
                    away: "Reste du Tournoi",
                    league: TOURNAMENT_PRESETS[presetId]?.league || "international",
                    probs: [pct, 0, Math.max(0, 100 - pct)],
                    rawProbs: [pct / 100, 0, Math.max(0, 1 - pct / 100)],
                    selectedMarket: {
                      label: `🏆 Vainqueur Final : ${topWinner.team}`,
                      prob: Math.min(0.95, Math.max(0.03, pct / 100)),
                      pct,
                      bookOdd: topWinner.fairOutrightOdd,
                    },
                  });
                }}
              >
                🎰 + Ajouter Vainqueur au Coupon (@{topWinner.fairOutrightOdd.toFixed(2)})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Arbre Visuel Interactif 1/8 -> 1/4 -> 1/2 -> Finale */}
      <div className="fai-panel">
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>
          🗺️ Tableau Complet de Phase Finale (modifiable en direct)
        </h3>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))",
            gap: 12,
          }}
        >
          {/* Colonne 1/8 modifiables */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 900, color: "#00e5ff", marginBottom: 8 }}>
              HUITIÈMES DE FINALE (8 MATCHS)
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {pairs.map(([tA, tB], idx) => {
                const det = simResult.bracket.r16[idx];
                return (
                  <div
                    key={idx}
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.09)",
                      borderRadius: 10,
                      padding: 8,
                    }}
                  >
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                      <input
                        list="football-ai-clubs"
                        value={tA}
                        onChange={(e) => {
                          const next = pairs.map((p, i) => (i === idx ? [e.target.value, p[1]] : p));
                          setPairs(next);
                        }}
                        style={{
                          flex: 1,
                          background: "#090d24",
                          border: "1px solid #334155",
                          borderRadius: 6,
                          color: det?.winner === tA ? "#00e676" : "#fff",
                          fontSize: 11.5,
                          fontWeight: 700,
                          padding: "4px 6px",
                        }}
                      />
                      <span style={{ fontSize: 11, fontWeight: 800, color: "#00e5ff" }}>{det?.probA}%</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        list="football-ai-clubs"
                        value={tB}
                        onChange={(e) => {
                          const next = pairs.map((p, i) => (i === idx ? [p[0], e.target.value] : p));
                          setPairs(next);
                        }}
                        style={{
                          flex: 1,
                          background: "#090d24",
                          border: "1px solid #334155",
                          borderRadius: 6,
                          color: det?.winner === tB ? "#00e676" : "#fff",
                          fontSize: 11.5,
                          fontWeight: 700,
                          padding: "4px 6px",
                        }}
                      />
                      <span style={{ fontSize: 11, fontWeight: 800, color: "#d500f9" }}>{det?.probB}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quarts + Demies + Finale projetés */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 900, color: "#c084fc", marginBottom: 8 }}>
              QUARTS DE FINALE PROJETÉS
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {simResult.bracket.qf.map((q, i) => (
                <div
                  key={i}
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(192,132,252,0.25)",
                    borderRadius: 10,
                    padding: 10,
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: q.winner === q.teamA ? 900 : 500, color: q.winner === q.teamA ? "#00e676" : "#cbd5e1" }}>
                    <span>{q.teamA}</span>
                    <span>{q.probA}%</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontWeight: q.winner === q.teamB ? 900 : 500, color: q.winner === q.teamB ? "#00e676" : "#cbd5e1" }}>
                    <span>{q.teamB}</span>
                    <span>{q.probB}%</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 11, fontWeight: 900, color: "#fbbf24", margin: "14px 0 8px" }}>
              DEMI-FINALES &amp; GRANDE FINALE
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {simResult.bracket.sf.map((s, i) => (
                <div
                  key={i}
                  style={{
                    background: "rgba(251,191,36,0.08)",
                    border: "1px solid rgba(251,191,36,0.3)",
                    borderRadius: 10,
                    padding: 10,
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontSize: 10, color: "#fbbf24", fontWeight: 800 }}>DEMI-FINALE #{i + 1}</div>
                  <div style={{ fontWeight: 800, marginTop: 3 }}>
                    {s.teamA} ({s.probA}%) vs {s.teamB} ({s.probB}%) ➔{" "}
                    <span style={{ color: "#00e676" }}>{s.winner}</span>
                  </div>
                </div>
              ))}

              {simResult.bracket.final && (
                <div
                  style={{
                    background: "linear-gradient(135deg, rgba(0,230,118,0.16), rgba(0,229,255,0.14))",
                    border: "1px solid #00e676",
                    borderRadius: 12,
                    padding: 12,
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 900, color: "#69f0ae" }}>🏆 FINALE PROJETÉE</div>
                  <div style={{ fontSize: 15, fontWeight: 900, color: "#fff", marginTop: 4 }}>
                    {simResult.bracket.final.teamA} ({simResult.bracket.final.probA}%) vs{" "}
                    {simResult.bracket.final.teamB} ({simResult.bracket.final.probB}%)
                  </div>
                  <div style={{ fontSize: 12, color: "#fbbf24", fontWeight: 800, marginTop: 4 }}>
                    👑 Champion le plus probable : {simResult.bracket.mostLikelyChampion}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Classement probabiliste complet des 16 équipes */}
      <div className="fai-panel">
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>
          📊 Probabilités Exactes sur 10 000 Tournois Complets
        </h3>
        <div style={{ display: "grid", gap: 8 }}>
          {simResult.leaderboard.map((row, idx) => (
            <div
              key={row.team}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(130px, 1.3fr) 2fr auto",
                alignItems: "center",
                gap: 10,
                background: "rgba(255,255,255,0.03)",
                padding: "9px 12px",
                borderRadius: 10,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 13 }}>
                <span style={{ color: idx < 3 ? "#fbbf24" : "#64748b", marginRight: 6 }}>
                  #{idx + 1}
                </span>
                {row.team}
              </div>
              <div style={{ background: "rgba(255,255,255,0.08)", height: 9, borderRadius: 999, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${Math.min(100, row.championPct * 2.5)}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, #00e5ff, #00e676)",
                  }}
                />
              </div>
              <div style={{ fontSize: 12, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                <strong style={{ color: "#00e676" }}>🏆 {row.championPct}%</strong>{" "}
                <span style={{ color: "#94a3b8" }}>(Fin: {row.finalPct}% • 1/2: {row.sfPct}%)</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
