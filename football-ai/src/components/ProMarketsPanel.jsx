import { useMemo } from "react";
import { computeProMatchMarkets } from "../engine/proMarketsEngine.js";

export default function ProMarketsPanel({ pred, matchContext, onAddCustomMarket }) {
  const pro = useMemo(
    () => (pred ? computeProMatchMarkets(pred, matchContext) : null),
    [pred, matchContext]
  );

  if (!pro) return null;

  const pushPick = (label, pct, odd) => {
    if (!onAddCustomMarket) return;
    onAddCustomMarket({
      home: pred.home,
      away: pred.away,
      league: pred.league,
      probs: pred.probs,
      selectedMarket: {
        label,
        pct,
        bookOdd: odd,
      },
    });
  };

  return (
    <div className="fai-panel" style={{ marginTop: 16 }}>
      <div className="fai-section-title" style={{ marginBottom: 12 }}>
        <span>🎯 Marchés Pros Haute Valeur — Buteurs • Corners • Cartons • Mi-Temps</span>
      </div>

      {/* 1. BUTEURS LES PLUS PROBABLES AVEC PROTECTION COMPOSITIONS OFFICIELLES H-60 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#00e5ff", marginBottom: 6 }}>
          ⚽ Top Buteurs Probables du Match (Modèle Poisson Individuel)
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#ffea00",
            background: "rgba(255, 234, 0, 0.08)",
            border: "1px solid rgba(255, 234, 0, 0.3)",
            borderRadius: 8,
            padding: "6px 10px",
            marginBottom: 8,
          }}
        >
          ⚠️ <strong>Protection Financière Buteurs :</strong> ne validez un pari Buteur qu&apos;après publication de la composition officielle (<strong>H-60 min avant le coup d&apos;envoi</strong>). Un remplaçant entrant à la 85e minute n&apos;est pas remboursé chez la majorité des bookmakers.
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
            gap: 8,
          }}
        >
          {pro.topScorers.map((s) => (
            <div
              key={s.id}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(0,229,255,0.22)",
                borderRadius: 12,
                padding: 10,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 6,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>{s.name}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>
                  {s.team} • {s.expectedGoals} xG attendu
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <span style={{ fontSize: 17, fontWeight: 900, color: "#00e676" }}>{s.pct}%</span>
                <button
                  type="button"
                  className="fai-btn-ghost"
                  style={{ padding: "4px 8px", fontSize: 11 }}
                  onClick={() => pushPick(`⚽ Buteur : ${s.name}`, s.pct, s.marketOdd)}
                >
                  + Coupon (@{s.marketOdd.toFixed(2)})
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 2. CORNERS + CARTONS + MI-TEMPS */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(225px, 1fr))",
          gap: 12,
        }}
      >
        {/* CORNERS */}
        <div
          style={{
            background: "rgba(255,255,255,0.035)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, color: "#38bdf8", marginBottom: 6 }}>
            🚩 Corners Projetés : {pro.corners.total} ({pro.corners.home} - {pro.corners.away})
          </div>
          {[
            [`🚩 +8.5 Corners dans le match`, pro.corners.over85Pct, pro.corners.over85Odd],
            [`🚩 +9.5 Corners dans le match`, pro.corners.over95Pct, pro.corners.over95Odd],
            [`🚩 +10.5 Corners dans le match`, pro.corners.over105Pct, pro.corners.over105Odd],
          ].map(([lbl, pct, odd]) => (
            <div
              key={lbl}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                padding: "5px 0",
                borderTop: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span>
                {lbl.replace(" dans le match", "")} : <strong>{pct}%</strong>
              </span>
              <button
                type="button"
                className="fai-btn-ghost"
                style={{ padding: "3px 8px", fontSize: 11 }}
                onClick={() => pushPick(lbl, pct, odd)}
              >
                @{odd.toFixed(2)} +
              </button>
            </div>
          ))}
        </div>

        {/* CARTONS */}
        <div
          style={{
            background: "rgba(255,255,255,0.035)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, color: "#fbbf24", marginBottom: 6 }}>
            🟨 Cartons Attendus : {pro.cards.expectedTotal} • Rouge : {pro.cards.redCardRiskPct}%
          </div>
          {[
            [`🟨 +3.5 Cartons dans le match`, pro.cards.over35Pct, pro.cards.over35Odd],
            [`🟨 +4.5 Cartons dans le match`, pro.cards.over45Pct, pro.cards.over45Odd],
          ].map(([lbl, pct, odd]) => (
            <div
              key={lbl}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                padding: "5px 0",
                borderTop: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span>
                {lbl.replace(" dans le match", "")} : <strong>{pct}%</strong>
              </span>
              <button
                type="button"
                className="fai-btn-ghost"
                style={{ padding: "3px 8px", fontSize: 11 }}
                onClick={() => pushPick(lbl, pct, odd)}
              >
                @{odd.toFixed(2)} +
              </button>
            </div>
          ))}
        </div>

        {/* MI-TEMPS */}
        <div
          style={{
            background: "rgba(255,255,255,0.035)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, color: "#c084fc", marginBottom: 6 }}>
            ⏱️ Scénarios 1re Mi-Temps
          </div>
          {[
            [`⏱️ +0.5 But en 1re Mi-Temps`, pro.halfTime.over05Pct, pro.halfTime.over05Odd],
            [`⏱️ Match Nul à la Mi-Temps`, pro.halfTime.drawHtPct, pro.halfTime.drawHtOdd],
          ].map(([lbl, pct, odd]) => (
            <div
              key={lbl}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                padding: "5px 0",
                borderTop: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span>
                {lbl} : <strong>{pct}%</strong>
              </span>
              <button
                type="button"
                className="fai-btn-ghost"
                style={{ padding: "3px 8px", fontSize: 11 }}
                onClick={() => pushPick(lbl, pct, odd)}
              >
                @{odd.toFixed(2)} +
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
