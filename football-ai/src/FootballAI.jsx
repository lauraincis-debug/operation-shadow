import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LEAGUES,
  CLUBS_DB,
  CALIBRATION_MATCHES,
  getClubsForLeague,
  resolveClub,
  canonicalTeamName,
  normalizeKey,
} from "./data/clubs.js";
import {
  OUTCOMES,
  isValidated,
  rebuildModelState,
  runContinuousEvolution,
  computeFullPrediction,
  generateExpertAnalysis,
  getConfidence,
  checkPickResult,
  MIN_PERFORMANCE_SAMPLE,
} from "./engine/predictor.js";
import {
  loadFirebaseSyncConfig,
  saveFirebaseSyncConfig,
  pushStateToFirebase,
  pullStateFromFirebase,
} from "./firebase/cloudSync.js";
import {
  loadExternalApiConfig,
  fetchScheduleForOffset,
  peekCachedScheduleForOffset,
  isMatchFeedFresh,
  OMNI_SPORT_ENDPOINTS,
} from "./services/liveMatchesApi.js";
import { predictOmniSportMatch } from "./engine/omniSportEngine.js";
import LiveMatchesTab from "./components/LiveMatchesTab.jsx";
import HeadToHeadTab from "./components/HeadToHeadTab.jsx";
import VideoAnalysisTab from "./components/VideoAnalysisTab.jsx";
import BookmakerScreenshotTab from "./components/BookmakerScreenshotTab.jsx";
import { doesVideoInsightMatchTeams } from "./engine/videoAnalyzer.js";
import FantasyTab from "./components/FantasyTab.jsx";
import CloeBridgeTab from "./components/CloeBridgeTab.jsx";
import InPlayTab from "./components/InPlayTab.jsx";
import BankrollAndTicketsPanel from "./components/BankrollAndTicketsPanel.jsx";
import TournamentTab from "./components/TournamentTab.jsx";
import ProMarketsPanel from "./components/ProMarketsPanel.jsx";
import LearningPerformanceBubble from "./components/LearningPerformanceBubble.jsx";
import {
  FATIGUE_OPTIONS,
  STAKES_OPTIONS,
  getSquadStarsForTeam,
} from "./engine/contextModifiers.js";

// ============================================================
// FOOTBALL AI ULTRA v6.4 Certifiée Intégrale — Application Complète Auto-Évolutive
// ============================================================

const STORAGE_KEY = "football_ai_ultra_v2";
const LEGACY_KEY = "football_ai_memory";

function normalizeCurrency(curr) {
  return curr === "EUR" || curr === "€" ? "EUR" : "XOF";
}

function getCouponLegProb(item) {
  if (!item || typeof item !== "object") return 0.65;
  if (typeof item.selectedMarket?.prob === "number" && Number.isFinite(item.selectedMarket.prob)) {
    return Math.min(0.98, Math.max(0.03, item.selectedMarket.prob));
  }
  if (typeof item.selectedMarket?.pct === "number" && Number.isFinite(item.selectedMarket.pct)) {
    return Math.min(0.98, Math.max(0.03, item.selectedMarket.pct / 100));
  }
  if (Array.isArray(item.rawProbs) && item.rawProbs.length > 0) {
    return Math.min(0.98, Math.max(0.03, Math.max(...item.rawProbs)));
  }
  if (Array.isArray(item.probs) && item.probs.length > 0) {
    return Math.min(0.98, Math.max(0.03, Math.max(...item.probs) / 100));
  }
  return 0.65;
}

function sanitizeCouponList(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object" && item.home && item.away)
    .map((item, idx) => {
      const prob = getCouponLegProb(item);
      const probs =
        Array.isArray(item.probs) && item.probs.length >= 3
          ? item.probs
          : [Math.round(prob * 100), 20, Math.max(5, 80 - Math.round(prob * 100))];
      const rawProbs =
        Array.isArray(item.rawProbs) && item.rawProbs.length >= 3
          ? item.rawProbs
          : probs.map((p) => Number(p) / 100);
      return {
        ...item,
        id: item.id ?? Date.now() + idx,
        sport: item.sport || "soccer",
        probs,
        rawProbs,
        selectedMarket: {
          ...(item.selectedMarket || { label: "Choix IA" }),
          prob,
          pct: item.selectedMarket?.pct ?? Math.round(prob * 100),
          bookOdd: Number(item.selectedMarket?.bookOdd || item.selectedMarket?.marketOdd || 1.5),
        },
      };
    });
}

function isLegacyCalibrationRecord(item) {
  return CALIBRATION_MATCHES.some(
    (fixture) =>
      fixture.league === item.league &&
      normalizeKey(canonicalTeamName(fixture.home)) === normalizeKey(canonicalTeamName(item.home)) &&
      normalizeKey(canonicalTeamName(fixture.away)) === normalizeKey(canonicalTeamName(item.away)) &&
      fixture.date === item.date &&
      fixture.scoreHome === item.scoreHome &&
      fixture.scoreAway === item.scoreAway
  );
}

function findOfficialFixtureForTeams(home, away, matches = []) {
  const homeKey = normalizeKey(canonicalTeamName(home));
  const awayKey = normalizeKey(canonicalTeamName(away));
  return matches.find(
    (match) =>
      (match.sport || "soccer") === "soccer" &&
      normalizeKey(canonicalTeamName(match.home)) === homeKey &&
      normalizeKey(canonicalTeamName(match.away)) === awayKey
  ) || null;
}

function buildForecastProvenance(fixture, liveFeed) {
  const issuedAt = Date.now();
  const forecastIssuedAtIso = new Date(issuedAt).toISOString();
  const kickoffAt = fixture?.kickoffIso ? new Date(fixture.kickoffIso).getTime() : NaN;
  const isOfficialPreMatch = Boolean(
    fixture?.isRealInternet === true &&
      fixture.externalId &&
      fixture.state === "pre" &&
      fixture.completed !== true &&
      Number.isFinite(kickoffAt) &&
      issuedAt < kickoffAt &&
      liveFeed?.isLiveNetwork === true &&
      liveFeed?.isSnapshot !== true &&
      liveFeed?.isCached !== true &&
      isMatchFeedFresh(fixture, issuedAt)
  );

  return {
    ...(fixture?.externalId ? { externalId: fixture.externalId } : {}),
    ...(fixture?.kickoffIso ? { kickoffIso: fixture.kickoffIso } : {}),
    createdAtIso: forecastIssuedAtIso,
    forecastIssuedAtIso,
    predictionPhase: isOfficialPreMatch ? "pre-match" : fixture?.state === "in" ? "in-play" : "unverified",
    predictionOrigin: fixture ? "user-issued" : "manual-unlinked",
    performanceEligible: isOfficialPreMatch,
    ...(!isOfficialPreMatch
      ? {
          performanceExclusionReason: fixture
            ? "Match officiel non confirmé en pré-match par un flux réseau récent"
            : "Aucun événement officiel correspondant dans le calendrier récent",
        }
      : {}),
  };
}

function sanitizePredictionsMemory(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => {
      if (!item || typeof item !== "object" || !item.home || !item.away) return false;
      if (item.sport && item.sport !== "soccer") return false;
      if (
        typeof item.scoreHome === "number" &&
        typeof item.scoreAway === "number" &&
        (item.scoreHome > 15 || item.scoreAway > 15)
      ) {
        return false;
      }
      return true;
    })
    .map((item) =>
      item.isCalibrationFixture || isLegacyCalibrationRecord(item)
        ? {
            ...item,
            isCalibrationFixture: true,
            performanceEligible: false,
            predictionOrigin: "historical-test-fixture",
          }
        : item
    );
}

function loadPersistedData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        predictions: sanitizePredictionsMemory(parsed.predictions),
        coupon: sanitizeCouponList(parsed.coupon),
        stake: typeof parsed.stake === "number" ? parsed.stake : 2000,
        currency: normalizeCurrency(parsed.currency),
        optaOverrides: parsed.optaOverrides || {},
        evolvedHyper: parsed.evolvedHyper || null,
        learnedExternalIds: Array.isArray(parsed.learnedExternalIds)
          ? parsed.learnedExternalIds
          : [],
      };
    }
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      return {
        predictions: sanitizePredictionsMemory(legacy.predictions),
        coupon: [],
        stake: 2000,
        currency: "XOF",
        optaOverrides: {},
        evolvedHyper: null,
        learnedExternalIds: [],
      };
    }
  } catch {
    // ignore
  }
  return {
    predictions: [],
    coupon: [],
    stake: 2000,
    currency: "XOF",
    optaOverrides: {},
    evolvedHyper: null,
    learnedExternalIds: [],
  };
}

function savePersistedData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

function formatMoney(amount, currency) {
  if (normalizeCurrency(currency) !== "EUR") {
    return `${Math.round(amount).toLocaleString("fr-FR")} FCFA`;
  }
  return `${amount.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

function Stars({ count }) {
  return (
    <span style={{ letterSpacing: 2 }} aria-label={`${count} étoiles sur 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          style={{
            color: i <= count ? "#ffd700" : "#2b3058",
            fontSize: 14,
          }}
        >
          ★
        </span>
      ))}
    </span>
  );
}

function FormBadges({ form }) {
  if (!form || form.length === 0) {
    return <span style={{ fontSize: 11, color: "#5e6790" }}>Forme initiale</span>;
  }
  return (
    <span>
      {form.map((res, idx) => {
        const bg =
          res === "V"
            ? "rgba(0, 230, 118, 0.2)"
            : res === "N"
              ? "rgba(255, 234, 0, 0.18)"
              : "rgba(255, 61, 90, 0.2)";
        const col = res === "V" ? "#00e676" : res === "N" ? "#ffea00" : "#ff3d5a";
        return (
          <span key={idx} className="fai-form-dot" style={{ background: bg, color: col }}>
            {res}
          </span>
        );
      })}
    </span>
  );
}

function ProbBar({ label, value, fairOdd, subInfo, color, isWinner, valueItem }) {
  return (
    <div style={{ marginBottom: 13 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 5,
          fontSize: 13,
          color: isWinner ? "#fff" : "#a2abcd",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: isWinner ? 800 : 500 }}>{label}</span>
          {valueItem?.isValue && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 800,
                padding: "2px 7px",
                borderRadius: 999,
                background: "rgba(0, 230, 118, 0.18)",
                border: "1px solid #00e676",
                color: "#00e676",
              }}
            >
              VALUE +{valueItem.evPct}%
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-mono)" }}>
          {subInfo && <span style={{ fontSize: 11, color: "#68729b" }}>{subInfo}</span>}
          {fairOdd && (
            <span
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 5,
                background: "rgba(255,255,255,0.05)",
                color: "#9aa3c7",
              }}
            >
              Cote IA {fairOdd.toFixed(2)}
            </span>
          )}
          <span style={{ fontWeight: 800, fontSize: 15, color: isWinner ? color : "#cfd6f4" }}>
            {value}%
          </span>
        </div>
      </div>
      <div style={{ height: 9, background: "#141836", borderRadius: 5, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${value}%`,
            background: isWinner
              ? `linear-gradient(90deg, ${color}cc, ${color})`
              : "linear-gradient(90deg, #323968, #48528e)",
            borderRadius: 5,
            transition: "width 0.45s cubic-bezier(0.4, 0, 0.2, 1)",
            boxShadow: isWinner ? `0 0 14px ${color}66` : "none",
          }}
        />
      </div>
    </div>
  );
}

function ScoreHeatmap({ heatmap, homeName, awayName }) {
  const maxCellProb = useMemo(() => {
    let m = 0.01;
    for (const row of heatmap) {
      for (const cell of row) {
        if (cell.prob > m) m = cell.prob;
      }
    }
    return m;
  }, [heatmap]);

  return (
    <div>
      <div style={{ fontSize: 11, color: "#7f89b2", marginBottom: 6 }}>
        Lignes : <strong>{homeName}</strong> (0–4 buts) • Colonnes : <strong>{awayName}</strong> (0–4 buts)
      </div>
      <div className="fai-heatmap">
        <div />
        {[0, 1, 2, 3, 4].map((col) => (
          <div
            key={`h-${col}`}
            style={{
              textAlign: "center",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "#7f89b2",
              fontWeight: 700,
            }}
          >
            {col}
          </div>
        ))}
        {heatmap.map((row, x) => [
          <div
            key={`lbl-${x}`}
            style={{
              textAlign: "center",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "#7f89b2",
              fontWeight: 700,
            }}
          >
            {x}
          </div>,
          ...row.map((cell, y) => {
            const intensity = Math.min(1, cell.prob / maxCellProb);
            const baseRgb =
              x > y ? "0, 229, 255" : x === y ? "255, 214, 0" : "255, 77, 136";
            return (
              <div
                key={`c-${x}-${y}`}
                className="fai-heat-cell"
                title={`Score exact ${x} - ${y} : ${cell.pct}%`}
                style={{
                  background: `rgba(${baseRgb}, ${(0.06 + intensity * 0.48).toFixed(2)})`,
                  color: intensity > 0.55 ? "#ffffff" : "#9aa3c7",
                  fontWeight: intensity > 0.6 ? 800 : 500,
                  borderColor:
                    intensity > 0.85 ? `rgba(${baseRgb}, 0.8)` : "rgba(255,255,255,0.05)",
                }}
              >
                {cell.pct.toFixed(1)}%
              </div>
            );
          }),
        ])}
      </div>
    </div>
  );
}

function LearningCurveChart({ curve }) {
  if (!curve || curve.length < 2) return null;
  const W = 440;
  const H = 120;
  const pts = curve
    .map((c, idx) => {
      const x = 16 + (idx / Math.max(1, curve.length - 1)) * (W - 32);
      const y = H - 16 - (c.cumulativeAcc / 100) * (H - 32);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 130 }}>
      {[25, 50, 75].map((pct) => {
        const y = H - 16 - (pct / 100) * (H - 32);
        return (
          <g key={pct}>
            <line
              x1={16}
              y1={y}
              x2={W - 16}
              y2={y}
              stroke="rgba(255,255,255,0.08)"
              strokeDasharray="3,3"
            />
            <text x={2} y={y + 3} fill="#6b749e" fontSize="9">
              {pct}%
            </text>
          </g>
        );
      })}
      <polyline
        fill="none"
        stroke="#00e676"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
    </svg>
  );
}

function PredictionCard({ pred, onValidate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [scoreH, setScoreH] = useState(
    typeof pred.scoreHome === "number" ? String(pred.scoreHome) : ""
  );
  const [scoreA, setScoreA] = useState(
    typeof pred.scoreAway === "number" ? String(pred.scoreAway) : ""
  );

  const validated = isValidated(pred);
  const maxIdx = pred.probs.indexOf(Math.max(...pred.probs));
  const conf = getConfidence(pred.probs, pred.rawProbs);
  const is1X2Hit = validated ? pred.result === maxIdx : null;
  const pickWon = validated ? checkPickResult(pred) : null;

  const submitExactScore = (e) => {
    e.preventDefault();
    const h = parseInt(scoreH, 10);
    const a = parseInt(scoreA, 10);
    if (Number.isNaN(h) || Number.isNaN(a) || h < 0 || a < 0 || h > 20 || a > 20) return;
    const outcome = h > a ? 0 : h === a ? 1 : 2;
    onValidate(pred.id, outcome, h, a);
    setEditing(false);
  };

  return (
    <div
      style={{
        background: "linear-gradient(140deg, #0c0f26 0%, #131738 100%)",
        border: `1px solid ${
          validated ? (is1X2Hit ? "rgba(0,230,118,0.65)" : "rgba(255,61,90,0.55)") : "#232954"
        }`,
        borderRadius: 16,
        padding: 20,
        marginBottom: 14,
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: LEAGUES[pred.league]?.color || "#7c4dff",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 1.5,
              marginBottom: 4,
            }}
          >
            {LEAGUES[pred.league]?.name || pred.league}
            {pred.autoLearned && (
              <span style={{ marginLeft: 8, color: "#00e5ff" }}>• 🤖 Auto-Appris Live</span>
            )}
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span>{pred.home}</span>
            {typeof pred.scoreHome === "number" && typeof pred.scoreAway === "number" ? (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  padding: "2px 10px",
                  borderRadius: 8,
                  background: "rgba(0, 229, 255, 0.14)",
                  border: "1px solid rgba(0, 229, 255, 0.35)",
                  color: "#00e5ff",
                  fontSize: 15,
                }}
              >
                {pred.scoreHome} - {pred.scoreAway}
              </span>
            ) : (
              <span style={{ color: "#5c658e", fontSize: 14 }}>vs</span>
            )}
            <span>{pred.away}</span>
          </div>
          <div style={{ fontSize: 11, color: "#68729b", marginTop: 4 }}>
            📅 {pred.date}
            {pred.xg && (
              <span>
                {" "}
                • Projection IA : {pred.xg.home.toFixed(2)} - {pred.xg.away.toFixed(2)} xG
              </span>
            )}
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: conf.color,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 3,
            }}
          >
            Fiabilité {conf.score}/100 • {conf.label}
          </div>
          <Stars count={conf.stars} />
        </div>
      </div>

      {pred.probs.map((p, i) => (
        <ProbBar
          key={i}
          label={OUTCOMES[i]}
          value={p}
          fairOdd={pred.fairOdds?.[i]}
          color={conf.color}
          isWinner={i === maxIdx}
        />
      ))}

      <div
        style={{
          marginTop: 12,
          padding: "10px 14px",
          background: "#080a1c",
          borderRadius: 10,
          border: `1px solid ${conf.color}40`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 12 }}>
            <span style={{ color: "#7882ab", textTransform: "uppercase", fontSize: 10, letterSpacing: 1 }}>
              Pronostic 1X2 :{" "}
            </span>
            <strong style={{ color: conf.color }}>{OUTCOMES[maxIdx]}</strong>
          </div>
          {pred.selectedMarket && (
            <div style={{ fontSize: 11, color: "#9aa3c7", marginTop: 2 }}>
              Option Coupon : <strong>{pred.selectedMarket.label}</strong> ({pred.selectedMarket.pct}%)
              {pickWon !== null && (
                <span style={{ marginLeft: 6, color: pickWon ? "#00e676" : "#ff3d5a", fontWeight: 700 }}>
                  {pickWon ? "✓ Option gagnante" : "✗ Option perdue"}
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {validated && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 800,
                padding: "5px 10px",
                borderRadius: 8,
                background: is1X2Hit ? "rgba(0,230,118,0.16)" : "rgba(255,61,90,0.16)",
                color: is1X2Hit ? "#00e676" : "#ff3d5a",
              }}
            >
              {is1X2Hit ? "✓ 1X2 Exact" : `✗ Réel : ${OUTCOMES[pred.result]}`}
            </span>
          )}
          <button
            type="button"
            className="fai-btn-ghost"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Fermer" : validated ? "Modifier score" : "✓ Valider résultat"}
          </button>
          <button
            type="button"
            onClick={() => onDelete(pred.id)}
            style={{
              background: "transparent",
              border: "none",
              color: "#6b749e",
              cursor: "pointer",
              fontSize: 12,
              padding: "4px 6px",
            }}
            title="Supprimer"
          >
            ✕
          </button>
        </div>
      </div>

      {editing && (
        <div
          style={{
            marginTop: 12,
            padding: 14,
            borderRadius: 10,
            background: "rgba(18, 22, 52, 0.9)",
            border: "1px solid #2b3368",
          }}
        >
          <form
            onSubmit={submitExactScore}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: "#00e5ff" }}>
              ⚽ Score exact :
            </span>
            <input
              type="number"
              min="0"
              max="20"
              placeholder={pred.home}
              value={scoreH}
              onChange={(e) => setScoreH(e.target.value)}
              className="fai-input"
              style={{ width: 82, padding: "7px 10px", textAlign: "center" }}
            />
            <span style={{ fontWeight: 800 }}>-</span>
            <input
              type="number"
              min="0"
              max="20"
              placeholder={pred.away}
              value={scoreA}
              onChange={(e) => setScoreA(e.target.value)}
              className="fai-input"
              style={{ width: 82, padding: "7px 10px", textAlign: "center" }}
            />
            <button type="submit" className="fai-btn-secondary">
              Enregistrer &amp; Recalibrer IA
            </button>
          </form>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {OUTCOMES.map((o, i) => (
              <button
                key={i}
                type="button"
                className="fai-btn-ghost"
                style={{ flex: 1, minWidth: 120 }}
                onClick={() => {
                  onValidate(pred.id, i, undefined, undefined);
                  setEditing(false);
                }}
              >
                {o}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// COMPOSANT PRINCIPAL : FOOTBALL AI ULTRA v6.4 Certifiée Intégrale
// ============================================================

export default function FootballAI() {
  const initial = useMemo(() => loadPersistedData(), []);
  const [predictions, setPredictions] = useState(initial.predictions);
  const [coupon, setCoupon] = useState(initial.coupon);
  const [stake, setStake] = useState(initial.stake);
  const [currency, setCurrency] = useState(initial.currency);
  const [optaOverrides, setOptaOverrides] = useState(initial.optaOverrides);
  const [evolvedHyper, setEvolvedHyper] = useState(initial.evolvedHyper);
  const [learnedExternalIds, setLearnedExternalIds] = useState(initial.learnedExternalIds);

  const [tab, setTab] = useState("predict");
  const [form, setForm] = useState({
    home: "PSG",
    away: "Marseille",
    league: "ligue1",
  });
  const [showOddsInput, setShowOddsInput] = useState(false);
  const [bookOdds, setBookOdds] = useState({ odd1: "", oddN: "", odd2: "" });
  const [showContextBox, setShowContextBox] = useState(false);
  const [matchContext, setMatchContext] = useState({
    absentHomeIds: [],
    absentAwayIds: [],
    fatigueHome: "fresh",
    fatigueAway: "fresh",
    stakes: "standard",
  });
  const [activeMatch, setActiveMatch] = useState({
    home: "PSG",
    away: "Marseille",
    league: "ligue1",
  });
  const [selectedMarketCode, setSelectedMarketCode] = useState(null);
  const [showAnalysis, setShowAnalysis] = useState(true);
  const [videoInsight, setVideoInsight] = useState(null);

  // État des Matchs du Jour & Demain (API Live)
  const [apiCfg, setApiCfg] = useState(() => loadExternalApiConfig());
  const [dayOffset, setDayOffset] = useState(0);
  const [rawLiveFeed, setRawLiveFeed] = useState({
    matches: [],
    providerUsed: "Initialisation...",
    isLiveNetwork: false,
  });
  const [loadingLive, setLoadingLive] = useState(false);

  const [historyFilter, setHistoryFilter] = useState("all");
  const [historySearch, setHistorySearch] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const [cloudCfg, setCloudCfg] = useState(() => loadFirebaseSyncConfig());
  const [cloudBusy, setCloudBusy] = useState(false);
  const [toast, setToast] = useState("");
  const fileInputRef = useRef(null);

  const triggerToast = useCallback((msg) => {
    setToast(msg);
  }, []);

  // Réception instantanée bidirectionnelle SÉCURISÉE depuis Cloé · Agent personnel · Abidjan (#sync=...)
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.location.hash.startsWith("#sync=")) {
        const rawB64 = window.location.hash.slice(6);
        window.history.replaceState(null, "", window.location.pathname);
        if (rawB64.length <= 24000) {
          const decoded = JSON.parse(decodeURIComponent(escape(atob(rawB64))));
          const cleanStr = (v, max = 80) => String(v || "").replace(/[<>`]/g, "").slice(0, max);
          if (decoded && typeof decoded === "object") {
            const incomingCurr =
              decoded.currency === "FCFA" || decoded.currency === "XOF" ? "XOF" : "EUR";
            setCurrency(incomingCurr);
            if (decoded.stake) setStake(Math.max(100, Number(decoded.stake) || 1000));
            if (decoded.capital) {
              const prevBk = JSON.parse(localStorage.getItem("football_ai_bankroll_v4") || "{}");
              localStorage.setItem(
                "football_ai_bankroll_v4",
                JSON.stringify({
                  ...prevBk,
                  unitCurrency: incomingCurr,
                  currentCapital: Math.max(0, Number(decoded.capital) || 50000),
                })
              );
            }
            if (Array.isArray(decoded.coupon) && decoded.coupon.length > 0) {
              setCoupon(
                decoded.coupon.slice(0, 12).map((it, idx) => ({
                  id: `cloe-sync-${Date.now()}-${idx}`,
                  home: cleanStr(it.home, 60),
                  away: cleanStr(it.away, 60),
                  sport: cleanStr(it.sport || "soccer", 20),
                  league: cleanStr(it.league || "ucl", 24),
                  probs: Array.isArray(it.probs) ? it.probs.map((x) => Number(x) || 33) : [50, 25, 25],
                  rawProbs: [0.5, 0.25, 0.25],
                  selectedMarket: {
                    code: cleanStr(it.selectedMarket?.code || "rec", 20),
                    label: cleanStr(it.selectedMarket?.label || it.label || "Double Chance", 90),
                    prob: Math.min(0.98, Math.max(0.03, (Number(it.selectedMarket?.pct || it.pct || 72)) / 100)),
                    pct: Math.min(98, Math.max(3, Math.round(Number(it.selectedMarket?.pct || it.pct || 72)))),
                    bookOdd: Math.min(100, Math.max(1.02, Number(it.selectedMarket?.bookOdd || it.odd) || 1.35)),
                  },
                }))
              );
              setTab("coupon");
            }
            triggerToast("🔗 Synchronisé en toute sécurité avec Cloé · Abidjan v6.4 Certifiée Intégrale !");
          }
        }
      }
    } catch {
      // ignore invalid hash
    }
  }, [triggerToast]);

  useEffect(() => {
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setInstallPromptEvent(e);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  const isStandalonePWA =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)")?.matches ||
      window.navigator?.standalone === true);

  const handleInstallPWA = async () => {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      await installPromptEvent.userChoice.catch(() => {});
      setInstallPromptEvent(null);
      return;
    }
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    if (/iphone|ipad|ipod/i.test(ua)) {
      triggerToast(
        "📱 Sur iPhone/iPad : touchez « Partager ⬆️ » dans Safari puis « Sur l'écran d'accueil ➕ » !"
      );
    } else {
      triggerToast(
        "📲 Menu navigateur (⋮) → « Installer l'application » ou « Ajouter à l'écran d'accueil » !"
      );
    }
  };

  const handleShareAppToFriends = async () => {
    const appUrl = "https://football-ai-43e33.web.app";
    const inviteText =
      "⚡ Teste l'application Omni-Sport & Football AI Ultra v6.4 (100 % gratuite, sans inscription ni aucune restriction) :\n" +
      "• 🌐 7 Sports en direct (Football, NBA, Tennis, NFL, NHL, MLB, UFC)\n" +
      "• 📸 Scanner de captures Betclic / 1xBet / Sportcash / Winamax ➔ 1 seul Pari Définitif optimal\n" +
      "• 🔴 Vidéos & flux Live des matchs EN COURS + Simulations 10 000× & Coupon FCFA / €\n" +
      `👉 Ouvre directement ici : ${appUrl}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: "⚡ Omni-Sport & Football AI Ultra v6.4",
          text: inviteText,
          url: appUrl,
        });
        return;
      }
      await navigator.clipboard.writeText(inviteText);
      triggerToast("📋 Invitation + lien copiés ! Colle directement dans WhatsApp, Telegram ou SMS.");
    } catch {
      try {
        await navigator.clipboard.writeText(appUrl);
        triggerToast("📋 Lien https://football-ai-43e33.web.app copié !");
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Persistance intégrale de la mémoire enrichie v6.4
  useEffect(() => {
    savePersistedData({
      predictions,
      coupon,
      stake,
      currency,
      optaOverrides,
      evolvedHyper,
      learnedExternalIds,
    });
  }, [predictions, coupon, stake, currency, optaOverrides, evolvedHyper, learnedExternalIds]);

  // Reconstruction mémoïsée de toute l'intelligence adaptative + Journal d'Erreurs
  const modelState = useMemo(
    () => rebuildModelState(predictions, { optaOverrides, evolvedHyper }),
    [predictions, optaOverrides, evolvedHyper]
  );

  // Enrichir chaque match du calendrier live avec sa prédiction mathématique à jour
  const enrichedLiveFeed = useMemo(
    () => {
      const schemaTracker = {};
      return {
        ...rawLiveFeed,
        matches: (rawLiveFeed.matches || []).map((m) => {
          const isSoccer = (m.sport || "soccer") === "soccer";
          const pred = isSoccer
            ? computeFullPrediction(m.home, m.away, m.league, modelState, m.liveOdds, {
                neutralVenue: m.neutralSite,
                liveIntel: m,
                schemaCounts: schemaTracker,
              })
            : predictOmniSportMatch(m);
          if (pred?.recommendedMarket?.code) {
            schemaTracker[pred.recommendedMarket.code] =
              (schemaTracker[pred.recommendedMarket.code] || 0) + 1;
          }
          return {
            ...m,
            prediction: pred,
          };
        }),
      };
    },
    [rawLiveFeed, modelState]
  );

  // Chargement ultra-vif SWR (0 ms si en cache mémoire/local + revalidation réseau parallèle)
  const loadDayMatches = useCallback(
    async (offset, cfgOverride = null) => {
      const instant = peekCachedScheduleForOffset(offset);
      if (instant) {
        setRawLiveFeed(instant);
      } else {
        setLoadingLive(true);
      }
      try {
        const feed = await fetchScheduleForOffset(offset, cfgOverride || apiCfg);
        setRawLiveFeed(feed);
      } catch {
        // ignore
      }
      setLoadingLive(false);
    },
    [apiCfg]
  );

  // Ingérer automatiquement les vrais matchs de FOOTBALL terminés (Hier + Aujourd'hui) pour apprentissage continu !
  const ingestFinishedMatches = useCallback(
    async (silent = false) => {
      const schedulePayloads = await Promise.all([
        fetchScheduleForOffset(-1, apiCfg),
        fetchScheduleForOffset(0, apiCfg),
      ]);
      const seenFinishedIds = new Set();
      // Les scores ne sont intégrés que s'ils proviennent d'un endpoint officiel ou d'un snapshot récent.
      const completedReal = schedulePayloads
        .filter((payload) => payload?.isTrustedResults === true)
        .flatMap((payload) => payload.matches || [])
        .filter((match) => {
          if (
            !match ||
            match.isRealInternet !== true ||
            !match.externalId ||
            (match.sport && match.sport !== "soccer") ||
            !match.completed ||
            typeof match.scoreHome !== "number" ||
            typeof match.scoreAway !== "number" ||
            match.scoreHome > 15 ||
            match.scoreAway > 15 ||
            seenFinishedIds.has(match.externalId)
          ) {
            return false;
          }
          seenFinishedIds.add(match.externalId);
          return true;
        });

      if (completedReal.length === 0) {
        if (!silent) {
          triggerToast("ℹ️ Aucun nouveau match terminé détecté pour l'instant.");
        }
        return;
      }

      setPredictions((prev) => {
        const knownExt = new Set(learnedExternalIds);
        let updatedList = sanitizePredictionsMemory(prev);
        let addedCount = 0;
        let autoValidatedCount = 0;
        const observedAtFallback = new Date().toISOString();
        const isSameFixture = (existing, match) => {
          if (existing.externalId && existing.externalId === match.externalId) return true;
          const sameTeams =
            normalizeKey(canonicalTeamName(existing.home)) === normalizeKey(canonicalTeamName(match.home)) &&
            normalizeKey(canonicalTeamName(existing.away)) === normalizeKey(canonicalTeamName(match.away));
          const existingKickoff = new Date(existing.kickoffIso || "").getTime();
          const matchKickoff = new Date(match.kickoffIso || "").getTime();
          return (
            sameTeams &&
            Number.isFinite(existingKickoff) &&
            Number.isFinite(matchKickoff) &&
            Math.abs(existingKickoff - matchKickoff) <= 30 * 60 * 1000
          );
        };

        for (const m of completedReal) {
          const outcome = m.scoreHome > m.scoreAway ? 0 : m.scoreHome === m.scoreAway ? 1 : 2;
          const resultObservedAtIso = m.fetchedAtIso || observedAtFallback;

          // Ne valider qu'un pronostic lié au même identifiant ou au même coup d'envoi vérifié.
          updatedList = updatedList.map((existing) => {
            if (existing.verifiedResult !== true && isSameFixture(existing, m)) {
              autoValidatedCount += 1;
              const exactEventIdMatch = existing.externalId === m.externalId;
              return {
                ...existing,
                result: outcome,
                scoreHome: m.scoreHome,
                scoreAway: m.scoreAway,
                verifiedResult: true,
                resultSource: "official-feed",
                resultObservedAtIso,
                verifiedResultExternalId: m.externalId,
                performanceEligible: existing.performanceEligible === true && exactEventIdMatch,
                ...(!exactEventIdMatch
                  ? { performanceExclusionReason: "Identifiant de résultat différent de celui du pronostic" }
                  : {}),
              };
            }
            return existing;
          });

          // L'intégration post-match alimente les profils, mais n'est jamais comptée comme pronostic émis.
          if (!knownExt.has(m.externalId)) {
            knownExt.add(m.externalId);
            const curState = rebuildModelState(updatedList, { optaOverrides, evolvedHyper });
            const pred = computeFullPrediction(m.home, m.away, m.league, curState, m.liveOdds);
            updatedList = [
              {
                id: Date.now() + addedCount * 10 + Math.floor(Math.random() * 9),
                externalId: m.externalId,
                autoLearned: true,
                performanceEligible: false,
                predictionPhase: "post-match-learning",
                predictionOrigin: "post-match-ingestion",
                createdAtIso: new Date().toISOString(),
                kickoffIso: m.kickoffIso || undefined,
                resultObservedAtIso,
                resultSource: "official-feed",
                verifiedResult: true,
                verifiedResultExternalId: m.externalId,
                home: pred.home,
                away: pred.away,
                league: m.league,
                probs: pred.probs,
                rawProbs: pred.rawProbs,
                fairOdds: pred.fairOdds,
                xg: pred.xg,
                selectedMarket: {
                  ...pred.recommendedMarket,
                  bookOdd: pred.recommendedMarket.marketOdd,
                },
                date: m.dateFr || new Date().toLocaleDateString("fr-FR"),
                result: outcome,
                scoreHome: m.scoreHome,
                scoreAway: m.scoreAway,
              },
              ...updatedList,
            ];
            addedCount += 1;
          }
        }

        if (addedCount > 0 || autoValidatedCount > 0) {
          setLearnedExternalIds(Array.from(knownExt));
          // Déclencher automatiquement un cycle d'évolution multi-époques !
          const evolved = runContinuousEvolution(updatedList, evolvedHyper || {}, optaOverrides);
          setEvolvedHyper(evolved.evolvedHyper);
          triggerToast(
            `🧬 Auto-Apprentissage Continu : +${addedCount + autoValidatedCount} vrais résultats appris (Génération #${evolved.evolvedHyper.generation}) !`
          );
        } else if (!silent) {
          triggerToast("✓ Mémoire IA déjà synchronisée avec tous les derniers résultats réels !");
        }

        return updatedList;
      });
    },
    [apiCfg, learnedExternalIds, optaOverrides, evolvedHyper, triggerToast]
  );

  // Au démarrage de l'application : charger Aujourd'hui + auto-apprendre les résultats récents
  useEffect(() => {
    loadDayMatches(0);
    if (apiCfg.autoLearnResults !== false) {
      ingestFinishedMatches(true);
    }
  }, []);

  const leagueClubs = useMemo(() => getClubsForLeague(form.league), [form.league]);

  // Prédiction temps réel pour le match actif (intégrant le signal Vidéo IA s'il est actif !)
  const livePrediction = useMemo(() => {
    if (!activeMatch.home.trim() || !activeMatch.away.trim()) return null;
    if (normalizeKey(activeMatch.home) === normalizeKey(activeMatch.away)) return null;
    return computeFullPrediction(
      activeMatch.home,
      activeMatch.away,
      activeMatch.league,
      modelState,
      bookOdds,
      {
        videoBoost: doesVideoInsightMatchTeams(videoInsight, activeMatch.home, activeMatch.away)
          ? videoInsight
          : null,
        matchContext,
      }
    );
  }, [activeMatch, modelState, bookOdds, videoInsight, matchContext]);

  useEffect(() => {
    if (livePrediction) {
      setSelectedMarketCode(livePrediction.recommendedMarket.code);
    }
  }, [livePrediction?.home, livePrediction?.away, livePrediction?.league]);

  const currentPickedMarket = useMemo(() => {
    if (!livePrediction) return null;
    return (
      livePrediction.markets.find((m) => m.code === selectedMarketCode) ||
      livePrediction.recommendedMarket
    );
  }, [livePrediction, selectedMarketCode]);

  const expertNarrative = useMemo(() => {
    if (!livePrediction) return "";
    const matchedVideo = doesVideoInsightMatchTeams(
      videoInsight,
      activeMatch.home,
      activeMatch.away
    )
      ? videoInsight
      : null;
    return generateExpertAnalysis(livePrediction, modelState, matchedVideo);
  }, [livePrediction, modelState, videoInsight, activeMatch.home, activeMatch.away]);

  const handleAnalyzeSubmit = (e) => {
    if (e) e.preventDefault();
    if (!form.home.trim() || !form.away.trim()) {
      triggerToast("Veuillez renseigner les deux équipes.");
      return;
    }
    if (normalizeKey(form.home) === normalizeKey(form.away)) {
      triggerToast("Veuillez choisir deux équipes différentes.");
      return;
    }
    setActiveMatch({
      home: form.home.trim(),
      away: form.away.trim(),
      league: form.league,
    });
    setShowAnalysis(true);
  };

  const handleQuickFixture = (home, away) => {
    setForm((f) => ({ ...f, home, away }));
    setBookOdds({ odd1: "", oddN: "", odd2: "" });
    setActiveMatch({ home, away, league: form.league });
    setShowAnalysis(true);
  };

  const handleSwapTeams = () => {
    setForm((f) => {
      const next = { ...f, home: f.away, away: f.home };
      if (next.home.trim() && next.away.trim()) {
        setActiveMatch(next);
      }
      return next;
    });
    setBookOdds((o) => ({ odd1: o.odd2, oddN: o.oddN, odd2: o.odd1 }));
  };

  const buildPredictionRecord = () => {
    if (!livePrediction || !currentPickedMarket) return null;
    const customOddMap = {
      "1": parseFloat(bookOdds.odd1),
      N: parseFloat(bookOdds.oddN),
      "2": parseFloat(bookOdds.odd2),
    };
    const chosenOdd =
      !Number.isNaN(customOddMap[currentPickedMarket.code]) &&
      customOddMap[currentPickedMarket.code] > 1.01
        ? customOddMap[currentPickedMarket.code]
        : currentPickedMarket.marketOdd;
    const fixture = findOfficialFixtureForTeams(
      livePrediction.home,
      livePrediction.away,
      rawLiveFeed.matches || []
    );
    const provenance = buildForecastProvenance(fixture, rawLiveFeed);

    return {
      id: Date.now() + Math.floor(Math.random() * 1000),
      sport: "soccer",
      ...provenance,
      home: livePrediction.home,
      away: livePrediction.away,
      league: livePrediction.league,
      probs: livePrediction.probs,
      rawProbs: livePrediction.rawProbs,
      fairOdds: livePrediction.fairOdds,
      xg: livePrediction.xg,
      selectedMarket: {
        ...currentPickedMarket,
        bookOdd: chosenOdd,
      },
      date: new Date().toLocaleDateString("fr-FR"),
      result: undefined,
    };
  };

  const handleAddToCouponAndHistory = () => {
    const rec = buildPredictionRecord();
    if (!rec) return;
    setPredictions((prev) => [rec, ...prev]);
    setCoupon((prev) => [...prev, rec]);
    triggerToast(`✓ "${rec.home} vs ${rec.away}" ajouté au Coupon (${rec.selectedMarket.label})`);
    setTab("coupon");
  };

  const handleQuickAddLiveMatchCoupon = (liveMatch) => {
    const pred = liveMatch.prediction;
    const sport = liveMatch.sport || pred.sport || "soccer";
    const prob = pred.recommendedMarket?.prob ?? (pred.recommendedMarket?.pct || 68) / 100;
    const provenance =
      sport === "soccer" ? buildForecastProvenance(liveMatch, rawLiveFeed) : {};
    const rec = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      externalId: liveMatch.externalId,
      sport,
      ...provenance,
      home: pred.home,
      away: pred.away,
      league: liveMatch.league || "ucl",
      probs: pred.probs,
      rawProbs: pred.rawProbs || pred.probs.map((p) => p / 100),
      fairOdds: pred.fairOdds,
      xg: pred.xg,
      selectedMarket: {
        ...pred.recommendedMarket,
        prob,
        bookOdd: Number(
          pred.recommendedMarket.marketOdd ||
            pred.recommendedMarket.bookOdd ||
            pred.recommendedMarket.fairOdd ||
            1.5
        ),
      },
      date: liveMatch.dateFr || new Date().toLocaleDateString("fr-FR"),
      result: undefined,
    };
    if (sport === "soccer") {
      setPredictions((prev) => [rec, ...prev]);
    }
    setCoupon((prev) => [...prev, rec]);
    triggerToast(`🎰 "${pred.home} vs ${pred.away}" ajouté au Coupon !`);
  };

  const handleInspectLiveMatch = (liveMatch) => {
    setForm({ home: liveMatch.home, away: liveMatch.away, league: liveMatch.league });
    setBookOdds(liveMatch.liveOdds || { odd1: "", oddN: "", odd2: "" });
    if (liveMatch.liveOdds) setShowOddsInput(true);
    setActiveMatch({ home: liveMatch.home, away: liveMatch.away, league: liveMatch.league });
    setTab("predict");
  };

  const handleSaveHistoryOnly = () => {
    const rec = buildPredictionRecord();
    if (!rec) return;
    setPredictions((prev) => [rec, ...prev]);
    triggerToast("📥 Match enregistré dans l'Historique d'apprentissage");
  };

  const handleValidateMatch = useCallback(
    (id, result, scoreHome, scoreAway) => {
      const updateItem = (item) => {
        if (item.id !== id || item.verifiedResult === true) return item;
        return {
          ...item,
          result,
          scoreHome: typeof scoreHome === "number" ? scoreHome : item.scoreHome,
          scoreAway: typeof scoreAway === "number" ? scoreAway : item.scoreAway,
          resultSource: "manual",
          verifiedResult: false,
          resultObservedAtIso: new Date().toISOString(),
        };
      };
      setPredictions((prev) => {
        const next = prev.map(updateItem);
        const evolved = runContinuousEvolution(next, evolvedHyper || {}, optaOverrides);
        setEvolvedHyper(evolved.evolvedHyper);
        return next;
      });
      setCoupon((prev) => prev.map(updateItem));
      triggerToast("🧬 Erreur/Succès analysé — Modèle IA recalibré automatiquement !");
    },
    [evolvedHyper, optaOverrides, triggerToast]
  );

  const handleManualSelfEvolution = () => {
    const trainingCount = modelState.trainingMetrics.total;
    if (trainingCount < 6) {
      triggerToast(
        `Optimisation suspendue : ${trainingCount}/6 résultats d'apprentissage requis. Les exemples de calibration ne sont plus injectés dans la mémoire.`
      );
      return;
    }
    const res = runContinuousEvolution(predictions, modelState.hyper, optaOverrides);
    setEvolvedHyper(res.evolvedHyper);
    triggerToast(
      `🧬 Génération #${res.evolvedHyper.generation} optimisée sur le rejeu historique (Brier ${res.afterBrier?.toFixed(3) ?? "—"}, non assimilable à une performance prospective).`
    );
  };

  const handleDeleteMatch = useCallback((id) => {
    setPredictions((prev) => prev.filter((p) => p.id !== id));
    setCoupon((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleUpdateCouponOdd = (id, rawVal) => {
    const parsed = parseFloat(rawVal);
    setCoupon((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              selectedMarket: {
                ...item.selectedMarket,
                bookOdd: Number.isNaN(parsed) || parsed < 1.01 ? item.selectedMarket.bookOdd : parsed,
                rawOddInput: rawVal,
              },
            }
          : item
      )
    );
  };

  const handleExportJSON = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            version: "6.4.0",
            exportedAt: new Date().toISOString(),
            predictions,
            coupon,
            optaOverrides,
            evolvedHyper,
          },
          null,
          2
        ),
      ],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `football-ai-ultra-v6.4-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    triggerToast("📤 Sauvegarde complète v6.4 téléchargée !");
  };

  const handleImportJSON = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (Array.isArray(parsed.predictions)) {
          setPredictions(sanitizePredictionsMemory(parsed.predictions));
          if (Array.isArray(parsed.coupon)) setCoupon(sanitizeCouponList(parsed.coupon));
          if (parsed.optaOverrides) setOptaOverrides(parsed.optaOverrides);
          if (parsed.evolvedHyper) setEvolvedHyper(parsed.evolvedHyper);
          triggerToast(`📥 ${parsed.predictions.length} prédictions restaurées avec succès !`);
        }
      } catch {
        triggerToast("Fichier JSON invalide.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleConfirmedReset = () => {
    setPredictions([]);
    setCoupon([]);
    setOptaOverrides({});
    setEvolvedHyper(null);
    setLearnedExternalIds([]);
    setConfirmReset(false);
    triggerToast("🗑️ Mémoire IA réinitialisée.");
  };

  const buildCouponShareLink = () => {
    try {
      const payload = {
        currency: normalizeCurrency(currency),
        stake,
        coupon: coupon.slice(0, 12).map((c) => ({
          sport: c.sport || "soccer",
          home: c.home,
          away: c.away,
          league: c.league || "ucl",
          probs: c.probs,
          selectedMarket: {
            code: c.selectedMarket?.code || "rec",
            label: c.selectedMarket?.label || "Sélection IA",
            pct: c.selectedMarket?.pct || 70,
            bookOdd: Number(c.selectedMarket?.bookOdd || 1.5),
          },
        })),
      };
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      return `https://football-ai-43e33.web.app/#sync=${b64}`;
    } catch {
      return "https://football-ai-43e33.web.app";
    }
  };

  const handleShareCoupon = async () => {
    if (coupon.length === 0 || !couponSummary) return;
    const shareUrl = buildCouponShareLink();
    const lines = [
      `⚡ COUPON OMNI-SPORT & FOOTBALL AI ULTRA v6.4 (${coupon.length} match${coupon.length > 1 ? "s" : ""})`,
      "────────────────────────",
      ...coupon.map(
        (c, idx) =>
          `${idx + 1}. ${c.home} vs ${c.away} → ${c.selectedMarket?.label} (${c.selectedMarket?.pct}% | Cote ${Number(c.selectedMarket?.bookOdd || 1.5).toFixed(2)})`
      ),
      "────────────────────────",
      `📊 Cote totale : ${couponSummary.combinedBookOdd.toFixed(2)} | Probabilité IA : ${couponSummary.combinedProbPct}%`,
      `💰 Mise : ${formatMoney(stake, currency)} → Gain potentiel : ${formatMoney(couponSummary.potentialPayout, currency)}`,
      `🔗 Charger ce coupon en 1 clic dans l'app : ${shareUrl}`,
    ];
    const text = lines.join("\n");
    try {
      if (navigator.share) {
        await navigator.share({ title: "Mon Coupon Football AI Ultra v6.4", text });
        return;
      }
      await navigator.clipboard.writeText(text);
      triggerToast("📋 Coupon + lien interactif copiés (prêts pour WhatsApp / Telegram) !");
    } catch {
      triggerToast("📋 Résumé prêt à être partagé.");
    }
  };

  const handlePushCloud = async () => {
    setCloudBusy(true);
    saveFirebaseSyncConfig(cloudCfg);
    try {
      await pushStateToFirebase(
        cloudCfg.databaseUrl,
        cloudCfg.syncRoom,
        {
          predictions,
          coupon,
          stake,
          currency,
          optaOverrides,
          evolvedHyper,
        },
        {
          authToken: cloudCfg.authToken,
          encryptionPassphrase: cloudCfg.encryptionPassphrase,
        }
      );
      triggerToast("🔐 Mémoire & Coupon chiffrés E2EE AES-256-GCM envoyés sur Firebase !");
    } catch (err) {
      triggerToast(`⚠️ ${err.message}`);
    }
    setCloudBusy(false);
  };

  const handlePullCloud = async () => {
    setCloudBusy(true);
    saveFirebaseSyncConfig(cloudCfg);
    try {
      const data = await pullStateFromFirebase(cloudCfg.databaseUrl, cloudCfg.syncRoom, {
        authToken: cloudCfg.authToken,
        encryptionPassphrase: cloudCfg.encryptionPassphrase,
      });
      setPredictions(sanitizePredictionsMemory(data.predictions));
      if (Array.isArray(data.coupon)) setCoupon(sanitizeCouponList(data.coupon));
      if (typeof data.stake === "number") setStake(data.stake);
      if (data.currency) setCurrency(normalizeCurrency(data.currency));
      if (data.optaOverrides) setOptaOverrides(data.optaOverrides);
      if (data.evolvedHyper) setEvolvedHyper(data.evolvedHyper);
      triggerToast(`🔐 ${data.predictions.length} prédictions déchiffrées et restaurées depuis Firebase !`);
    } catch (err) {
      triggerToast(`⚠️ ${err.message}`);
    }
    setCloudBusy(false);
  };

  const couponSummary = useMemo(() => {
    if (coupon.length === 0) return null;
    let combinedProb = 1;
    let combinedBookOdd = 1;
    let weakestLeg = coupon[0];

    for (const item of coupon) {
      const legProb = getCouponLegProb(item);
      const legOdd = Number(item.selectedMarket?.bookOdd ?? 1.5);
      combinedProb *= legProb;
      combinedBookOdd *= legOdd;
      const weakestProb = getCouponLegProb(weakestLeg);
      if (legProb < weakestProb) {
        weakestLeg = item;
      }
    }

    const fairCombinedOdd = 1 / Math.max(combinedProb, 0.0001);
    const potentialPayout = stake * combinedBookOdd;
    const netProfit = potentialPayout - stake;
    const evPct = Math.round((combinedProb * combinedBookOdd - 1) * 1000) / 10;

    let riskLabel = "Faible (Ticket Solide)";
    let riskColor = "#00e676";
    if (combinedProb < 0.15) {
      riskLabel = "Très élevé (Loterie)";
      riskColor = "#ff3d5a";
    } else if (combinedProb < 0.32) {
      riskLabel = "Élevé (Audacieux)";
      riskColor = "#ff9100";
    } else if (combinedProb < 0.52) {
      riskLabel = "Modéré (Équilibré)";
      riskColor = "#ffea00";
    }

    return {
      combinedProbPct: Math.round(combinedProb * 1000) / 10,
      combinedBookOdd: Math.round(combinedBookOdd * 100) / 100,
      fairCombinedOdd: Math.round(fairCombinedOdd * 100) / 100,
      potentialPayout,
      netProfit,
      evPct,
      weakestLeg,
      riskLabel,
      riskColor,
    };
  }, [coupon, stake]);

  const historyRows = useMemo(
    () => predictions.filter((prediction) => prediction.isCalibrationFixture !== true),
    [predictions]
  );

  const filteredHistory = useMemo(() => {
    const q = normalizeKey(historySearch);
    return historyRows.filter((p) => {
      if (q) {
        const matchText = `${normalizeKey(p.home)} ${normalizeKey(p.away)} ${normalizeKey(LEAGUES[p.league]?.name)}`;
        if (!matchText.includes(q)) return false;
      }
      const val = isValidated(p);
      if (historyFilter === "pending") return !val;
      if (historyFilter === "correct") {
        return val && p.result === p.probs.indexOf(Math.max(...p.probs));
      }
      if (historyFilter === "wrong") {
        return val && p.result !== p.probs.indexOf(Math.max(...p.probs));
      }
      return true;
    });
  }, [historyRows, historyFilter, historySearch]);

  const learnedTeamsList = useMemo(
    () =>
      Object.values(modelState.teams)
        .filter((t) => t.games > 0)
        .sort((a, b) => b.elo - a.elo),
    [modelState.teams]
  );

  const discoveredSoccerTeams = useMemo(() => {
    const discovered = new Map();
    const addTeam = (rawName, source) => {
      const name = canonicalTeamName(rawName);
      const key = normalizeKey(name);
      if (!key || resolveClub(name) || discovered.has(key)) return;
      discovered.set(key, { name, source });
    };

    for (const match of rawLiveFeed.matches || []) {
      if ((match.sport || "soccer") !== "soccer") continue;
      addTeam(match.home, "calendrier officiel récent");
      addTeam(match.away, "calendrier officiel récent");
    }
    for (const team of learnedTeamsList) {
      addTeam(team.name, `${team.games} résultat(s) intégré(s)`);
    }
    return Array.from(discovered.values()).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }, [rawLiveFeed.matches, learnedTeamsList]);

  const homeClubPreview = useMemo(() => {
    const key = normalizeKey(canonicalTeamName(form.home));
    return modelState.teams[key] || resolveClub(form.home);
  }, [form.home, modelState.teams]);

  const awayClubPreview = useMemo(() => {
    const key = normalizeKey(canonicalTeamName(form.away));
    return modelState.teams[key] || resolveClub(form.away);
  }, [form.away, modelState.teams]);

  const acc = modelState.metrics.accuracyPct;
  const genNumber = modelState.hyper.learningGeneration || 1;

  const tabs = [
    { id: "live", label: `📅 Matchs du Jour (${enrichedLiveFeed.matches.length})` },
    { id: "predict", label: "🎯 Prédire" },
    { id: "screenshot", label: "📸 Capture Betclic" },
    { id: "inplay", label: "🔴 Live In-Play" },
    { id: "video", label: videoInsight ? "🔴 Vidéo Live ✓" : "🔴 Vidéo Live" },
    { id: "tournament", label: "🏆 Tournoi 10 000×" },
    { id: "h2h", label: "⚔️ Face-à-Face" },
    { id: "fantasy", label: "🏆 Fantasy IA" },
    { id: "cloe", label: "🤖 Cloé IA" },
    { id: "coupon", label: `🎰 Coupon (${coupon.length})` },
    { id: "history", label: `📊 Historique (${historyRows.length})` },
    { id: "stats", label: `🧠 Mémoire Gen #${genNumber}` },
  ];

  return (
    <div className="fai-app">
      <datalist id="football-ai-clubs">
        {leagueClubs.map((c) => (
          <option key={c.name} value={c.name}>
            {c.fullName} — Elo {c.elo}
          </option>
        ))}
        {CLUBS_DB.filter((c) => !c.leagues.includes(form.league)).map((c) => (
          <option key={`all-${c.name}`} value={c.name}>
            {c.fullName}
          </option>
        ))}
        {discoveredSoccerTeams.map((team) => (
          <option key={`discovered-${normalizeKey(team.name)}`} value={team.name}>
            {team.name} — {team.source}; profil à confirmer
          </option>
        ))}
      </datalist>

      {/* ====== HEADER COLLANT ====== */}
      <header className="fai-header">
        <div className="fai-container">
          <div className="fai-header-top">
            <div>
              <div className="fai-brand-title">
                <span className="fai-gradient-text">⚡ OMNI-SPORT &amp; FOOTBALL AI</span>
                <span className="fai-badge-version">
                  ULTRA v6.4 CERTIFIÉE INTÉGRALE • LIVE VIDÉO &amp; BETCLIC • GEN #{genNumber}
                </span>
              </div>
              <div className="fai-brand-sub">
                {OMNI_SPORT_ENDPOINTS.length} compétitions Live • {CLUBS_DB.length} clubs référencés + {discoveredSoccerTeams.length} équipes détectées • 📸 Betclic • 🔴 Vidéo en cours
              </div>
            </div>

            <div className="fai-header-kpis">
              <button
                type="button"
                className="fai-btn-secondary"
                onClick={handleShareAppToFriends}
                title="Envoyer l'application à vos amis sur WhatsApp, Telegram ou SMS"
              >
                📤 Partager aux Amis
              </button>
              {!isStandalonePWA && (
                <button
                  type="button"
                  className="fai-btn-secondary"
                  onClick={handleInstallPWA}
                  title="Installer l'application sur l'écran d'accueil Android, iPhone ou PC"
                >
                  📲 Installer l&apos;App
                </button>
              )}
              <div className="fai-kpi-pill" title={modelState.metrics.status}>
                <div
                  className="fai-kpi-val"
                  style={{
                    color:
                      acc === null ? "#9aa3c7" : acc >= 60 ? "#00e676" : acc >= 48 ? "#ffea00" : "#ff3d5a",
                  }}
                >
                  {acc === null ? "—" : `${acc}%`}
                </div>
                <div className="fai-kpi-lbl">
                  1X2 officiel ({modelState.metrics.total}/{MIN_PERFORMANCE_SAMPLE})
                </div>
              </div>
              <div className="fai-kpi-pill" title="Calculé sur les mêmes pronostics pré-match vérifiés">
                <div className="fai-kpi-val" style={{ color: modelState.metrics.marketAccuracyPct === null ? "#9aa3c7" : "#00e5ff" }}>
                  {modelState.metrics.marketAccuracyPct === null ? "—" : `${modelState.metrics.marketAccuracyPct}%`}
                </div>
                <div className="fai-kpi-lbl">Marchés officiels</div>
              </div>
            </div>
          </div>

          <nav className="fai-tabs" aria-label="Navigation principale">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`fai-tab-btn ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="fai-main">
        {/* BANDEAU P2 ONBOARDING CLAIR : GUIDE 1re UTILISATION & PROTECTION ANTI-PERTE */}
        <details
          style={{
            marginBottom: 14,
            background: "linear-gradient(135deg, rgba(0, 229, 255, 0.08), rgba(0, 230, 118, 0.06))",
            border: "1px solid rgba(0, 229, 255, 0.3)",
            borderRadius: 12,
            padding: "10px 14px",
            fontSize: 12.5,
            color: "#e2e8f0",
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 800, color: "#00e5ff" }}>
            🧭 Première visite ? Mode Guidé Débutant &amp; Règles d&apos;Or Anti-Perte Financière (cliquer pour ouvrir/fermer)
          </summary>
          <div style={{ marginTop: 8, display: "grid", gap: 6, color: "#cbd5e1", lineHeight: 1.5 }}>
            <div>
              • <strong>1. Privilégiez les badges verts « 🔒 VERROU ULTRA-FIABLE »</strong> (onglet Live) et évitez strictement les matchs marqués <strong>« ⛔ NO-BET • PIÈGE »</strong>.
            </div>
            <div>
              • <strong>2. Une probabilité de 75 % signifie 3 victoires sur 4, jamais 100 % :</strong> ne misez jamais plus de <strong>2 % à 5 %</strong> de votre capital sur un ticket.
            </div>
            <div>
              • <strong>3. Scanner Captures Bookmakers (Betclic / Winamax / 1xBet / Sportcash) :</strong> envoyez votre capture dans l&apos;onglet <strong>📸 Capture Betclic</strong> — l&apos;IA recalcule toutes les cotes proposées et extrait <strong>1 SEUL Pari Définitif optimal</strong> (ou bloque la mise à <strong>0 FCFA / 0 €</strong> si toutes les cotes sont à espérance négative).
            </div>
            <div>
              • <strong>4. Vidéos EN COURS uniquement &amp; Buteurs :</strong> l&apos;onglet <strong>🔴 Vidéo Live</strong> récupère les flux et vidéos en ligne <strong>strictement pour les matchs EN COURS</strong> (jamais après le coup de sifflet final) afin de parier en direct, et les paris Buteurs ne doivent être validés qu&apos;à <strong>H-60 min</strong> (compositions officielles).
            </div>
            <div style={{ color: "#86efac" }}>
              • <strong>🔓 Accès 100 % Libre &amp; Illimité (sans inscription ni quota) :</strong> tous les modules (7 Sports en direct, Scanner Betclic WASM, Vidéos Live, Simulations 10 000×, Fantasy 100 M€, Bankroll FCFA / €) sont débloqués sans aucune restriction. Chaque appareil conserve son propre portefeuille privé, et vous pouvez échanger un coupon complet entre amis en 1 clic via <strong>📤 Partager le Coupon</strong> !
            </div>
          </div>
        </details>
        {/* ======================================================
            ONGLET LIVE : MATCHS D'AUJOURD'HUI, DEMAIN & API / OPTA
           ====================================================== */}
        {tab === "live" && (
          <LiveMatchesTab
            dayOffset={dayOffset}
            onChangeDayOffset={(off) => {
              setDayOffset(off);
              loadDayMatches(off);
            }}
            liveFeed={enrichedLiveFeed}
            loadingLive={loadingLive}
            onRefreshLive={loadDayMatches}
            onAutoLearnCompleted={() => ingestFinishedMatches(false)}
            onInspectMatch={handleInspectLiveMatch}
            onQuickAddCoupon={handleQuickAddLiveMatchCoupon}
            predictionsHistory={predictions}
            onOpenInPlay={(m) => {
              setActiveMatch({ home: m.home, away: m.away, league: m.league || "ucl" });
              setTab("inplay");
            }}
            onApplyOptaOverrides={(overrides, count) => {
              setOptaOverrides((prev) => ({ ...prev, ...overrides }));
              triggerToast(`📊 ${count} profils Opta xG intégrés à la mémoire IA !`);
            }}
          />
        )}

        {/* ======================================================
            ONGLET PRÉDIRE & ANALYSER
           ====================================================== */}
        {tab === "predict" && (
          <div>
            <form className="fai-panel" onSubmit={handleAnalyzeSubmit}>
              <div className="fai-section-title">
                <span>⚙️ Configuration de la rencontre</span>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {doesVideoInsightMatchTeams(videoInsight, form.home, form.away) && (
                    <span style={{ color: "#00e676", fontSize: 11 }}>
                      🎥 Signal Vidéo IA actif (×{videoInsight.homeXgMult} / ×{videoInsight.awayXgMult})
                    </span>
                  )}
                  <span style={{ color: "#7f89b2", fontFamily: "var(--font-mono)" }}>
                    {CLUBS_DB.length} référencées + {discoveredSoccerTeams.length} détectées
                  </span>
                </div>
              </div>

              <div className="fai-league-grid">
                {Object.entries(LEAGUES).map(([key, lg]) => (
                  <button
                    key={key}
                    type="button"
                    className={`fai-league-pill ${form.league === key ? "selected" : ""}`}
                    onClick={() => {
                      const defaultPair = lg.featuredMatches[0];
                      setForm({ league: key, home: defaultPair[0], away: defaultPair[1] });
                      setActiveMatch({ league: key, home: defaultPair[0], away: defaultPair[1] });
                    }}
                  >
                    {lg.name}
                  </button>
                ))}
              </div>

              <div className="fai-quick-matches">
                <span style={{ fontSize: 11, color: "#68729b", textTransform: "uppercase", letterSpacing: 1 }}>
                  Affiches rapides :
                </span>
                {(LEAGUES[form.league]?.featuredMatches || []).map(([h, a]) => (
                  <button
                    key={`${h}-${a}`}
                    type="button"
                    className="fai-quick-chip"
                    onClick={() => handleQuickFixture(h, a)}
                  >
                    {h} vs {a}
                  </button>
                ))}
              </div>

              <div className="fai-teams-row">
                <div>
                  <label className="fai-label" htmlFor="input-home">
                    🏠 Équipe Domicile
                  </label>
                  <input
                    id="input-home"
                    list="football-ai-clubs"
                    className="fai-input"
                    value={form.home}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm((f) => ({ ...f, home: val }));
                      if (val.trim() && form.away.trim()) {
                        setActiveMatch({ home: val, away: form.away, league: form.league });
                      }
                    }}
                    placeholder="Ex: PSG, Liverpool, Real Madrid..."
                  />
                  <div className="fai-club-hint">
                    {homeClubPreview ? (
                      <>
                        <span style={{ color: "#00e5ff" }}>Elo {Math.round(homeClubPreview.elo)}</span>
                        <span>
                          Atk ×{homeClubPreview.atk.toFixed(2)} • Déf ×{homeClubPreview.def.toFixed(2)}
                        </span>
                        <span>
                          {homeClubPreview.games > 0
                            ? `${homeClubPreview.games} résultats intégrés`
                            : resolveClub(form.home)
                              ? "Base catalogue — pas de forme confirmée ici"
                              : "Profil par défaut — historique insuffisant"}
                        </span>
                      </>
                    ) : (
                      <span>Équipe détectée ou personnalisée • profil neutre Elo 1690</span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className="fai-swap-btn"
                  onClick={handleSwapTeams}
                  title="Inverser Domicile et Extérieur"
                >
                  ⇄
                </button>

                <div>
                  <label className="fai-label" htmlFor="input-away">
                    ✈️ Équipe Extérieur
                  </label>
                  <input
                    id="input-away"
                    list="football-ai-clubs"
                    className="fai-input"
                    value={form.away}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm((f) => ({ ...f, away: val }));
                      if (form.home.trim() && val.trim()) {
                        setActiveMatch({ home: form.home, away: val, league: form.league });
                      }
                    }}
                    placeholder="Ex: Marseille, Arsenal, FC Barcelone..."
                  />
                  <div className="fai-club-hint">
                    {awayClubPreview ? (
                      <>
                        <span style={{ color: "#9d7bff" }}>Elo {Math.round(awayClubPreview.elo)}</span>
                        <span>
                          Atk ×{awayClubPreview.atk.toFixed(2)} • Déf ×{awayClubPreview.def.toFixed(2)}
                        </span>
                        <span>
                          {awayClubPreview.games > 0
                            ? `${awayClubPreview.games} résultats intégrés`
                            : resolveClub(form.away)
                              ? "Base catalogue — pas de forme confirmée ici"
                              : "Profil par défaut — historique insuffisant"}
                        </span>
                      </>
                    ) : (
                      <span>Équipe détectée ou personnalisée • profil neutre Elo 1690</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="fai-odds-box">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    cursor: "pointer",
                  }}
                  onClick={() => setShowOddsInput((v) => !v)}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#cbd2f5" }}>
                    💰 Scanner de Cotes Bookmaker — Détecteur Value Bet &amp; Critère de Kelly
                  </span>
                  <span style={{ fontSize: 12, color: "#00e5ff", fontWeight: 700 }}>
                    {showOddsInput ? "Masquer ▲" : "Saisir les cotes ▼"}
                  </span>
                </div>

                {showOddsInput && (
                  <div className="fai-odds-grid">
                    {[
                      ["odd1", `Cote 1 (${form.home || "Dom."})`],
                      ["oddN", "Cote N (Match Nul)"],
                      ["odd2", `Cote 2 (${form.away || "Ext."})`],
                    ].map(([field, lbl]) => (
                      <div key={field}>
                        <label className="fai-label" style={{ fontSize: 10 }}>
                          {lbl}
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="1.01"
                          className="fai-input"
                          style={{ padding: "8px 10px" }}
                          placeholder="Ex: 1.85"
                          value={bookOdds[field]}
                          onChange={(e) =>
                            setBookOdds((prev) => ({ ...prev, [field]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* PANNEAU ABSENCES STARS, FATIGUE (<72H) & ENJEU TACTIQUE */}
              <div className="fai-odds-box" style={{ marginBottom: 14 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    cursor: "pointer",
                  }}
                  onClick={() => setShowContextBox((v) => !v)}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#cbd2f5" }}>
                    🏥 Absences Stars, Fatigue (&lt;72h) &amp; Enjeu Tactique{" "}
                    {matchContext.absentHomeIds.length + matchContext.absentAwayIds.length > 0 && (
                      <span style={{ color: "#ff5252" }}>
                        • {matchContext.absentHomeIds.length + matchContext.absentAwayIds.length} absent(s) actif(s)
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 12, color: "#00e676", fontWeight: 700 }}>
                    {showContextBox ? "Masquer ▲" : "Configurer ▼"}
                  </span>
                </div>

                {showContextBox && (
                  <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                        gap: 10,
                      }}
                    >
                      {[
                        { side: "absentHomeIds", team: form.home || "Domicile", fatKey: "fatigueHome" },
                        { side: "absentAwayIds", team: form.away || "Extérieur", fatKey: "fatigueAway" },
                      ].map(({ side, team, fatKey }) => {
                        const stars = getSquadStarsForTeam(team);
                        const selectedIds = matchContext[side];
                        return (
                          <div
                            key={side}
                            style={{
                              background: "rgba(6,8,24,0.65)",
                              border: "1px solid rgba(255,255,255,0.08)",
                              borderRadius: 10,
                              padding: 10,
                            }}
                          >
                            <div style={{ fontSize: 11, fontWeight: 800, color: "#00e5ff", marginBottom: 6 }}>
                              🚑 Absents / Blessés — {team}
                            </div>
                            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                              {stars.map((pl) => {
                                const isOut = selectedIds.includes(pl.id);
                                return (
                                  <button
                                    key={pl.id}
                                    type="button"
                                    onClick={() =>
                                      setMatchContext((prev) => ({
                                        ...prev,
                                        [side]: isOut
                                          ? prev[side].filter((id) => id !== pl.id)
                                          : [...prev[side], pl.id],
                                      }))
                                    }
                                    style={{
                                      background: isOut ? "rgba(255,61,113,0.28)" : "rgba(255,255,255,0.05)",
                                      border: `1px solid ${isOut ? "#ff3d71" : "rgba(255,255,255,0.14)"}`,
                                      color: isOut ? "#ff85a2" : "#cbd5e1",
                                      borderRadius: 999,
                                      padding: "4px 9px",
                                      fontSize: 11,
                                      fontWeight: 700,
                                      cursor: "pointer",
                                      textDecoration: isOut ? "line-through" : "none",
                                    }}
                                  >
                                    {isOut ? "✖ " : ""}
                                    {pl.name} ({pl.pos})
                                  </button>
                                );
                              })}
                            </div>
                            <select
                              className="fai-input"
                              style={{ fontSize: 11.5, padding: "6px 8px" }}
                              value={matchContext[fatKey]}
                              onChange={(e) =>
                                setMatchContext((prev) => ({ ...prev, [fatKey]: e.target.value }))
                              }
                            >
                              {FATIGUE_OPTIONS.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <select
                        className="fai-input"
                        style={{ flex: 1, fontSize: 12, padding: "8px 10px" }}
                        value={matchContext.stakes}
                        onChange={(e) =>
                          setMatchContext((prev) => ({ ...prev, stakes: e.target.value }))
                        }
                      >
                        {STAKES_OPTIONS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="fai-btn-ghost"
                        onClick={() =>
                          setMatchContext({
                            absentHomeIds: [],
                            absentAwayIds: [],
                            fatigueHome: "fresh",
                            fatigueAway: "fresh",
                            stakes: "standard",
                          })
                        }
                      >
                        Réinitialiser contexte
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="submit"
                  className="fai-btn-primary"
                  style={{ flex: "2 1 260px" }}
                  disabled={
                    !form.home.trim() ||
                    !form.away.trim() ||
                    normalizeKey(form.home) === normalizeKey(form.away)
                  }
                >
                  ⚡ Calculer la Prédiction &amp; l&apos;Analyse Tactique IA
                </button>
                <button
                  type="button"
                  className="fai-btn-secondary"
                  style={{ flex: "1 1 180px" }}
                  onClick={() => setTab("video")}
                >
                  🎥 Enrichir par Vidéo IA
                </button>
              </div>
            </form>

            {livePrediction && (
              <div className="fai-panel">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: 16,
                    flexWrap: "wrap",
                    paddingBottom: 18,
                    marginBottom: 20,
                    borderBottom: "1px solid var(--border-muted)",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        color: LEAGUES[livePrediction.league]?.color || "#00e5ff",
                        textTransform: "uppercase",
                        letterSpacing: 2,
                      }}
                    >
                      {LEAGUES[livePrediction.league]?.name}
                    </div>
                    <h2 style={{ fontSize: 24, fontWeight: 900, marginTop: 4 }}>
                      {livePrediction.home}{" "}
                      <span style={{ color: "#5e6790", fontWeight: 600 }}>vs</span>{" "}
                      {livePrediction.away}
                    </h2>
                    <div
                      style={{
                        display: "flex",
                        gap: 16,
                        flexWrap: "wrap",
                        marginTop: 8,
                        fontSize: 12,
                        color: "#9aa3c7",
                      }}
                    >
                      <span>
                        🏠 {livePrediction.home} :{" "}
                        <FormBadges form={livePrediction.elo.homeForm} />
                      </span>
                      <span>
                        ✈️ {livePrediction.away} :{" "}
                        <FormBadges form={livePrediction.elo.awayForm} />
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: 12,
                        background: "#080a1a",
                        border: "1px solid var(--border-muted)",
                        textAlign: "center",
                      }}
                    >
                      <div style={{ fontSize: 10, color: "#7f89b2", textTransform: "uppercase", letterSpacing: 1 }}>
                        Expected Goals (xG)
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 18,
                          fontWeight: 800,
                          color: "#00e5ff",
                          marginTop: 2,
                        }}
                      >
                        {livePrediction.xg.home.toFixed(2)}{" "}
                        <span style={{ color: "#58608a" }}>-</span>{" "}
                        {livePrediction.xg.away.toFixed(2)}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: 12,
                        background: "#080a1a",
                        border: `1px solid ${livePrediction.confidence.color}55`,
                        textAlign: "right",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          color: livePrediction.confidence.color,
                          textTransform: "uppercase",
                        }}
                      >
                        Fiabilité {livePrediction.confidence.score}/100 •{" "}
                        {livePrediction.confidence.label}
                      </div>
                      <Stars count={livePrediction.confidence.stars} />
                    </div>
                  </div>
                </div>

                <div className="fai-grid-2">
                  <div>
                    <div className="fai-section-title">
                      <span>📊 Probabilités Hybrides 1X2 (Somme exacte 100%)</span>
                      <span style={{ color: "#7f89b2", fontFamily: "var(--font-mono)" }}>
                        {livePrediction.modelsBreakdown.dcWeightPct}% Poisson /{" "}
                        {100 - livePrediction.modelsBreakdown.dcWeightPct}% Elo
                      </span>
                    </div>

                    {livePrediction.probs.map((pct, idx) => {
                      const maxIdx = livePrediction.probs.indexOf(
                        Math.max(...livePrediction.probs)
                      );
                      return (
                        <ProbBar
                          key={idx}
                          label={
                            idx === 0
                              ? `1 • Victoire ${livePrediction.home}`
                              : idx === 1
                                ? "N • Match Nul"
                                : `2 • Victoire ${livePrediction.away}`
                          }
                          value={pct}
                          fairOdd={livePrediction.fairOdds[idx]}
                          subInfo={`DC ${livePrediction.modelsBreakdown.dixonColes[idx]}% | Elo ${livePrediction.modelsBreakdown.eloLogit[idx]}%`}
                          color={livePrediction.confidence.color}
                          isWinner={idx === maxIdx}
                          valueItem={livePrediction.valueAnalysis?.items?.[idx]}
                        />
                      );
                    })}

                    {livePrediction.valueAnalysis && (
                      <div
                        style={{
                          marginTop: 14,
                          padding: 12,
                          borderRadius: 10,
                          background: livePrediction.valueAnalysis.bestValue?.isValue
                            ? "rgba(0, 230, 118, 0.09)"
                            : "rgba(255, 255, 255, 0.03)",
                          border: `1px solid ${
                            livePrediction.valueAnalysis.bestValue?.isValue
                              ? "#00e676"
                              : "var(--border-muted)"
                          }`,
                          fontSize: 12,
                        }}
                      >
                        {livePrediction.valueAnalysis.bestValue?.isValue ? (
                          <div>
                            <strong style={{ color: "#00e676" }}>
                              💎 VALUE BET DÉTECTÉ : {livePrediction.valueAnalysis.bestValue.label}
                            </strong>{" "}
                            à la cote <strong>{livePrediction.valueAnalysis.bestValue.bookOdd}</strong>{" "}
                            (Espérance <strong>+{livePrediction.valueAnalysis.bestValue.evPct}%</strong> •
                            Mise Kelly ¼ :{" "}
                            <strong>{livePrediction.valueAnalysis.bestValue.kellyPct}%</strong>).
                          </div>
                        ) : (
                          <div style={{ color: "#9aa3c7" }}>
                            Aucune value mathématique nette (&ge; +3%) détectée sur ces cotes.
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ marginTop: 18 }}>
                      <div className="fai-section-title">
                        <span>🎯 Top 6 Scores Exacts Probables</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {livePrediction.topScores.map((sc, i) => (
                          <div
                            key={sc.score}
                            style={{
                              flex: "1 1 82px",
                              padding: "8px 10px",
                              borderRadius: 10,
                              background: i === 0 ? "rgba(0, 229, 255, 0.14)" : "#080a1a",
                              border: `1px solid ${
                                i === 0 ? "rgba(0, 229, 255, 0.55)" : "var(--border-muted)"
                              }`,
                              textAlign: "center",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>
                              {sc.score}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: i === 0 ? "#00e5ff" : "#8e98c2",
                                marginTop: 2,
                              }}
                            >
                              {sc.pct}%
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="fai-section-title">
                      <span>🧮 Matrice Poisson Dixon-Coles (5×5)</span>
                    </div>
                    <ScoreHeatmap
                      heatmap={livePrediction.heatmap5x5}
                      homeName={livePrediction.home}
                      awayName={livePrediction.away}
                    />

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                        marginTop: 14,
                      }}
                    >
                      {[
                        ["+1.5 Buts", `${livePrediction.goals.over15Pct}%`],
                        ["+2.5 Buts", `${livePrediction.goals.over25Pct}%`],
                        ["-2.5 Buts", `${livePrediction.goals.under25Pct}%`],
                        ["BTTS (Les 2 marquent)", `${livePrediction.goals.bttsYesPct}%`],
                      ].map(([lbl, val]) => (
                        <div
                          key={lbl}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 9,
                            background: "#080a1a",
                            border: "1px solid var(--border-muted)",
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 12,
                          }}
                        >
                          <span style={{ color: "#9aa3c7" }}>{lbl}</span>
                          <strong style={{ fontFamily: "var(--font-mono)", color: "#fff" }}>
                            {val}
                          </strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 22 }}>
                  <div className="fai-section-title">
                    <span>🎰 Choisissez le Marché à ajouter au Coupon</span>
                    <span style={{ color: "#00e676" }}>
                      ★ Recommandation IA : {livePrediction.recommendedMarket.label} (
                      {livePrediction.recommendedMarket.pct}%)
                    </span>
                  </div>
                  <div className="fai-markets-grid">
                    {livePrediction.markets.map((m) => {
                      const isSelected = currentPickedMarket?.code === m.code;
                      const isRec = livePrediction.recommendedMarket.code === m.code;
                      return (
                        <button
                          key={m.code}
                          type="button"
                          className={`fai-market-card ${isSelected ? "active" : ""}`}
                          onClick={() => setSelectedMarketCode(m.code)}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 10,
                              color: isRec ? "#00e676" : "#7882ab",
                              textTransform: "uppercase",
                              marginBottom: 4,
                            }}
                          >
                            <span>{m.group}</span>
                            {isRec && <span>★ Choix sûr IA</span>}
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                            {m.label}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontFamily: "var(--font-mono)",
                              fontSize: 12,
                            }}
                          >
                            <span style={{ color: "#00e5ff", fontWeight: 800 }}>{m.pct}%</span>
                            <span style={{ color: "#9aa3c7" }}>~{m.marketOdd.toFixed(2)}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div
                  style={{
                    marginTop: 22,
                    padding: 18,
                    borderRadius: 14,
                    background: "linear-gradient(135deg, rgba(8,10,28,0.95), rgba(18,16,46,0.92))",
                    border: "1px solid rgba(124, 77, 255, 0.35)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: showAnalysis ? 10 : 0,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 800, color: "#00e5ff", letterSpacing: 1 }}>
                      🧠 SYNTHÈSE TACTIQUE &amp; MATHÉMATIQUE IA
                    </span>
                    <button
                      type="button"
                      className="fai-btn-ghost"
                      onClick={() => setShowAnalysis((v) => !v)}
                    >
                      {showAnalysis ? "Réduire" : "Afficher l'analyse"}
                    </button>
                  </div>
                  {showAnalysis && (
                    <div
                      style={{
                        fontSize: 13.5,
                        lineHeight: 1.65,
                        color: "#dce1ff",
                        whiteSpace: "pre-line",
                      }}
                    >
                      {expertNarrative}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="fai-btn-primary"
                    style={{ flex: "2 1 260px" }}
                    onClick={handleAddToCouponAndHistory}
                  >
                    🎰 Ajouter au Coupon ({currentPickedMarket?.label} •{" "}
                    {currentPickedMarket?.pct}%)
                  </button>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    style={{ flex: "1 1 190px" }}
                    onClick={handleSaveHistoryOnly}
                  >
                    📥 Enregistrer dans l&apos;Historique
                  </button>
                </div>

                {/* MARCHÉS PROS : BUTEURS + CORNERS + CARTONS + MI-TEMPS */}
                <ProMarketsPanel
                  pred={livePrediction}
                  matchContext={matchContext}
                  onAddCustomMarket={(customItem) => {
                    setCoupon((prev) => [
                      ...prev,
                      { ...customItem, id: Date.now() + Math.floor(Math.random() * 1000) },
                    ]);
                    triggerToast(`🎯 ${customItem.selectedMarket.label} ajouté au Coupon !`);
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* ======================================================
            ONGLET SIMULATEUR 10 000× DE TOURNOI (CAN / UCL / MONDIAL)
           ====================================================== */}
        {tab === "tournament" && (
          <TournamentTab
            modelState={modelState}
            onAddOutrightToCoupon={(item) => {
              setCoupon((prev) => [
                ...prev,
                { ...item, id: Date.now() + Math.floor(Math.random() * 1000) },
              ]);
              triggerToast(`🏆 ${item.selectedMarket.label} ajouté au Coupon !`);
            }}
          />
        )}

        {/* ======================================================
            ONGLET COMPARATEUR FACE-À-FACE (RADAR + MONTE-CARLO)
           ====================================================== */}
        {tab === "h2h" && (
          <HeadToHeadTab
            modelState={modelState}
            predictions={predictions}
            liveMatches={enrichedLiveFeed.matches}
            defaultHome={activeMatch.home}
            defaultAway={activeMatch.away}
            defaultLeague={activeMatch.league}
            onSendToPredict={(h, a, lg) => {
              setForm({ home: h, away: a, league: lg });
              setActiveMatch({ home: h, away: a, league: lg });
              setTab("predict");
            }}
          />
        )}

        {/* ======================================================
            ONGLET SCANNER CAPTURE BOOKMAKER (BETCLIC -> PARI DÉFINITIF)
           ====================================================== */}
        {tab === "screenshot" && (
          <BookmakerScreenshotTab
            liveMatches={enrichedLiveFeed.matches || []}
            modelState={modelState}
            videoInsight={videoInsight}
            currency={currency}
            bankrollCapital={currency === "EUR" ? 100 : 50000}
            onAddDefinitiveBetToCoupon={(newItem) => {
              const probFrac = Math.min(0.98, Math.max(0.03, (newItem.selectedMarket?.pct || 65) / 100));
              setCoupon((prev) => [
                ...prev,
                {
                  id: `betclic-${Date.now()}`,
                  home: newItem.home,
                  away: newItem.away,
                  sport: newItem.sport || "soccer",
                  league: newItem.league || "ucl",
                  probs: [Math.round(probFrac * 100), 20, Math.max(5, 80 - Math.round(probFrac * 100))],
                  rawProbs: [probFrac, 0.2, Math.max(0.05, 0.8 - probFrac)],
                  selectedMarket: {
                    ...newItem.selectedMarket,
                    prob: probFrac,
                  },
                },
              ]);
              setTab("coupon");
              triggerToast(`🏆 Pari Définitif « ${newItem.selectedMarket.label} » ajouté au Coupon !`);
            }}
          />
        )}

        {/* ======================================================
            ONGLET ANALYSE VIDÉO LIVE (UNIQUEMENT MATCHS EN COURS !)
           ====================================================== */}
        {tab === "video" && (
          <VideoAnalysisTab
            activeHome={activeMatch.home}
            activeAway={activeMatch.away}
            liveMatches={enrichedLiveFeed.matches || []}
            videoInsight={videoInsight}
            onSelectTargetMatch={(h, a) => {
              setForm((prev) => ({ ...prev, home: h, away: a }));
              setActiveMatch((prev) => ({ ...prev, home: h, away: a }));
            }}
            onAddLiveBetToCoupon={(liveItem) => {
              const probFrac = Math.min(0.98, Math.max(0.05, (liveItem.selectedMarket?.pct || 68) / 100));
              setCoupon((prev) => [
                ...prev,
                {
                  id: `live-vid-${Date.now()}`,
                  home: liveItem.home,
                  away: liveItem.away,
                  sport: liveItem.sport || "soccer",
                  league: liveItem.league || "ucl",
                  probs: [Math.round(probFrac * 100), 20, Math.max(5, 80 - Math.round(probFrac * 100))],
                  rawProbs: [probFrac, 0.2, Math.max(0.05, 0.8 - probFrac)],
                  selectedMarket: {
                    ...liveItem.selectedMarket,
                    prob: probFrac,
                  },
                },
              ]);
              setTab("coupon");
              triggerToast(`🔴 Pari Live « ${liveItem.selectedMarket.label} » ajouté au Coupon !`);
            }}
            onVideoInsightReady={(res) => {
              setVideoInsight(res);
              triggerToast(`🔴 Direct analysé — Pressing ${res.pressingScore}/100 !`);
            }}
            onClearVideoInsight={() => {
              setVideoInsight(null);
              triggerToast("Modificateur vidéo désactivé.");
            }}
            onApplyAndGoPredict={() => {
              triggerToast("⚡ Modificateurs xG Vidéo injectés dans la prédiction !");
              setTab("predict");
            }}
          />
        )}

        {/* ======================================================
            ONGLET FANTASY FOOTBALL IA (11 TYPE & CAPITAINE ×2)
           ====================================================== */}
        {tab === "fantasy" && (
          <FantasyTab modelState={modelState} liveMatches={enrichedLiveFeed.matches} />
        )}

        {/* ======================================================
            ONGLET PONT IA TEMPS RÉEL CLOÉ <-> FOOTBALL AI
           ====================================================== */}
        {tab === "cloe" && (
          <CloeBridgeTab
            predictions={predictions}
            coupon={coupon}
            stake={stake}
            currency={currency}
            optaOverrides={optaOverrides}
            evolvedHyper={evolvedHyper}
            learnedExternalIds={learnedExternalIds}
            liveFixturesSnapshot={{
              yesterday: [],
              today: enrichedLiveFeed.matches || [],
              tomorrow: [],
            }}
            showToast={triggerToast}
          />
        )}

        {/* ======================================================
            ONGLET MOTEUR LIVE IN-PLAY MINUTE PAR MINUTE
           ====================================================== */}
        {tab === "inplay" && (
          <InPlayTab
            defaultHome={activeMatch.home}
            defaultAway={activeMatch.away}
            defaultLeague={activeMatch.league}
            modelState={modelState}
            liveMatches={enrichedLiveFeed.matches}
            onAddLivePickToCoupon={(item) => {
              setCoupon((prev) => [
                ...prev,
                { ...item, id: Date.now() + Math.floor(Math.random() * 1000) },
              ]);
              triggerToast(`🎰 Sélection Live ajoutée au Coupon !`);
            }}
          />
        )}

        {/* ======================================================
            ONGLET COUPON COMBINÉ INTELLIGENT + 3 TICKETS AUTO + BANKROLL
           ====================================================== */}
        {tab === "coupon" && (
          <div>
            <BankrollAndTicketsPanel
              liveMatches={enrichedLiveFeed.matches}
              modelState={modelState}
              coupon={coupon}
              stake={stake}
              currency={currency}
              couponSummary={couponSummary}
              onLoadGeneratedTicket={(items, suggestedStake, badge) => {
                setCoupon(sanitizeCouponList(items));
                setStake(suggestedStake);
                triggerToast(`${badge} chargé avec mise optimale !`);
              }}
              onApplyRecommendedStake={(amt) => {
                setStake(amt);
                triggerToast(`🛡️ Mise optimale Kelly appliquée !`);
              }}
              onReplaceCouponItem={(itemId, saferMarket) => {
                setCoupon((prev) =>
                  prev.map((c) =>
                    c.id === itemId ? { ...c, selectedMarket: saferMarket } : c
                  )
                );
              }}
              showToast={triggerToast}
            />
            {coupon.length === 0 ? (
              <div className="fai-panel" style={{ textAlign: "center", padding: "48px 24px" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🎰</div>
                <h3 style={{ fontSize: 18, marginBottom: 8 }}>Votre Coupon Combiné est vide</h3>
                <p style={{ fontSize: 13, color: "#8e98c2", maxWidth: 460, margin: "0 auto 20px" }}>
                  Sélectionnez directement les meilleures opportunités dans{" "}
                  <strong>Matchs du Jour</strong> ou analysez un duel sur mesure dans{" "}
                  <strong>Prédire</strong>.
                </p>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    onClick={() => setTab("live")}
                  >
                    📅 Voir les Matchs du Jour
                  </button>
                  <button
                    type="button"
                    className="fai-btn-ghost"
                    onClick={() => setTab("predict")}
                  >
                    🎯 Analyser un match manuel
                  </button>
                </div>
              </div>
            ) : (
              <div className="fai-grid-2">
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 12,
                    }}
                  >
                    <span className="fai-section-title" style={{ marginBottom: 0 }}>
                      📋 Sélections du Ticket ({coupon.length})
                    </span>
                    <button
                      type="button"
                      className="fai-btn-ghost"
                      onClick={() => setCoupon([])}
                    >
                      🧹 Vider le coupon
                    </button>
                  </div>

                  {coupon.map((item) => {
                    const won = checkPickResult(item);
                    const isWeakest =
                      coupon.length > 1 && couponSummary?.weakestLeg?.id === item.id;
                    return (
                      <div
                        key={item.id}
                        className="fai-panel"
                        style={{
                          padding: 16,
                          marginBottom: 12,
                          borderColor:
                            won === true
                              ? "#00e676"
                              : won === false
                                ? "#ff3d5a"
                                : isWeakest
                                  ? "rgba(255, 145, 0, 0.55)"
                                  : "var(--border-muted)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            gap: 10,
                          }}
                        >
                          <div>
                            <div style={{ fontSize: 11, color: "#7f89b2" }}>
                              {LEAGUES[item.league]?.name} • {item.date}
                            </div>
                            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2 }}>
                              {item.home} vs {item.away}
                            </div>
                            <div
                              style={{
                                marginTop: 6,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "4px 10px",
                                borderRadius: 8,
                                background: "rgba(0, 229, 255, 0.1)",
                                color: "#00e5ff",
                                fontSize: 12,
                                fontWeight: 700,
                              }}
                            >
                              <span>🎯 {item.selectedMarket?.label}</span>
                              <span>({item.selectedMarket?.pct}%)</span>
                            </div>
                            {isWeakest && (
                              <div style={{ fontSize: 11, color: "#ff9100", marginTop: 6 }}>
                                ⚠️ Maillon le plus risqué du combiné
                              </div>
                            )}
                          </div>

                          <div style={{ textAlign: "right" }}>
                            <label
                              style={{
                                display: "block",
                                fontSize: 10,
                                color: "#7f89b2",
                                marginBottom: 4,
                              }}
                            >
                              COTE BOOKMAKER
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min="1.01"
                              className="fai-input"
                              style={{
                                width: 84,
                                padding: "6px 8px",
                                textAlign: "center",
                                fontFamily: "var(--font-mono)",
                              }}
                              value={
                                item.selectedMarket?.rawOddInput ??
                                item.selectedMarket?.bookOdd ??
                                1.5
                              }
                              onChange={(e) => handleUpdateCouponOdd(item.id, e.target.value)}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setCoupon((prev) => prev.filter((c) => c.id !== item.id))
                              }
                              style={{
                                display: "block",
                                marginLeft: "auto",
                                marginTop: 8,
                                background: "transparent",
                                border: "none",
                                color: "#7f89b2",
                                fontSize: 11,
                                cursor: "pointer",
                              }}
                            >
                              ✕ Retirer
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {couponSummary && (
                  <div className="fai-panel" style={{ alignSelf: "start" }}>
                    <div className="fai-section-title">
                      <span>💰 Simulateur Bankroll &amp; Gains</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[
                          { code: "XOF", label: "FCFA" },
                          { code: "EUR", label: "€" },
                        ].map(({ code, label }) => {
                          const isSelected = normalizeCurrency(currency) === code;
                          return (
                            <button
                              key={code}
                              type="button"
                              className="fai-btn-ghost"
                              style={{
                                padding: "3px 8px",
                                fontSize: 11,
                                borderColor: isSelected ? "#00e5ff" : undefined,
                                color: isSelected ? "#00e5ff" : undefined,
                              }}
                              onClick={() => {
                                setCurrency(code);
                                setStake(code === "XOF" ? 2000 : 10);
                              }}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <label className="fai-label">
                      Mise engagée ({normalizeCurrency(currency) === "EUR" ? "EUR €" : "FCFA"})
                    </label>
                    <input
                      type="number"
                      min="1"
                      className="fai-input"
                      style={{ fontFamily: "var(--font-mono)", fontSize: 16 }}
                      value={stake}
                      onChange={(e) => setStake(Math.max(0, Number(e.target.value) || 0))}
                    />

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {(normalizeCurrency(currency) === "XOF" ? [1000, 2000, 5000, 10000] : [5, 10, 25, 50]).map(
                        (preset) => (
                          <button
                            key={preset}
                            type="button"
                            className="fai-quick-chip"
                            onClick={() => setStake(preset)}
                          >
                            {preset.toLocaleString("fr-FR")}{" "}
                            {normalizeCurrency(currency) === "EUR" ? "€" : "FCFA"}
                          </button>
                        )
                      )}
                    </div>

                    <div
                      style={{
                        marginTop: 18,
                        padding: 16,
                        borderRadius: 12,
                        background: "#080a1a",
                        border: "1px solid var(--border-muted)",
                      }}
                    >
                      {[
                        ["Cote Totale Combinée", couponSummary.combinedBookOdd.toFixed(2), "#fff"],
                        [
                          "Probabilité Réelle IA",
                          `${couponSummary.combinedProbPct}%`,
                          couponSummary.riskColor,
                        ],
                        [
                          "Juste Cote Mathématique",
                          couponSummary.fairCombinedOdd.toFixed(2),
                          "#9aa3c7",
                        ],
                        [
                          "Espérance Mathématique (EV)",
                          `${couponSummary.evPct >= 0 ? "+" : ""}${couponSummary.evPct}%`,
                          couponSummary.evPct >= 0 ? "#00e676" : "#ff9100",
                        ],
                      ].map(([k, v, col]) => (
                        <div
                          key={k}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            padding: "7px 0",
                            borderBottom: "1px solid rgba(255,255,255,0.05)",
                            fontSize: 13,
                          }}
                        >
                          <span style={{ color: "#9aa3c7" }}>{k}</span>
                          <strong style={{ fontFamily: "var(--font-mono)", color: col }}>
                            {v}
                          </strong>
                        </div>
                      ))}

                      <div
                        style={{
                          marginTop: 14,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 700 }}>GAIN POTENTIEL</span>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 22,
                            fontWeight: 900,
                            color: "#00e676",
                          }}
                        >
                          {formatMoney(couponSummary.potentialPayout, currency)}
                        </span>
                      </div>
                      <div
                        style={{
                          textAlign: "right",
                          fontSize: 11,
                          color: "#7f89b2",
                          marginTop: 3,
                        }}
                      >
                        Bénéfice net : +{formatMoney(couponSummary.netProfit, currency)}
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: 12,
                        padding: 12,
                        borderRadius: 10,
                        background: `${couponSummary.riskColor}14`,
                        border: `1px solid ${couponSummary.riskColor}55`,
                        fontSize: 12,
                      }}
                    >
                      <strong style={{ color: couponSummary.riskColor }}>
                        Profil de risque : {couponSummary.riskLabel}
                      </strong>
                    </div>

                    <button
                      type="button"
                      className="fai-btn-primary"
                      style={{ marginTop: 14 }}
                      onClick={handleShareCoupon}
                    >
                      📤 Partager / Copier le Coupon (WhatsApp • Telegram)
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ======================================================
            ONGLET HISTORIQUE & VALIDATION
           ====================================================== */}
        {tab === "history" && (
          <div>
            <div className="fai-panel" style={{ padding: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[
                    ["all", `Tous (${historyRows.length})`],
                    [
                      "pending",
                      `⏳ À valider (${historyRows.filter((p) => !isValidated(p)).length})`,
                    ],
                    ["correct", `✓ IA Correcte (${modelState.metrics.correct})`],
                    ["wrong", `✗ Erreurs Apprises (${modelState.errorJournal.length})`],
                  ].map(([id, lbl]) => (
                    <button
                      key={id}
                      type="button"
                      className={`fai-league-pill ${historyFilter === id ? "selected" : ""}`}
                      onClick={() => setHistoryFilter(id)}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    onClick={() => ingestFinishedMatches(false)}
                  >
                    🔄 Auto-Valider Résultats Officiels
                  </button>
                  <input
                    className="fai-input"
                    style={{ maxWidth: 210, padding: "8px 12px", fontSize: 12 }}
                    placeholder="🔍 Filtrer par club..."
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {filteredHistory.length === 0 ? (
              <div className="fai-panel" style={{ textAlign: "center", padding: "44px 20px" }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📊</div>
                <p style={{ color: "#9aa3c7", fontSize: 14, marginBottom: 16 }}>
                  Aucun pronostic enregistré ici. Pour mesurer la performance, créez un pronostic
                  avant le coup d&apos;envoi depuis un événement officiel récent; les jeux de calibration
                  rétrospectifs ne sont pas comptés.
                </p>
                <button
                  type="button"
                  className="fai-btn-secondary"
                  onClick={() => setTab("live")}
                >
                  📅 Choisir un événement officiel
                </button>
                <button
                  type="button"
                  className="fai-btn-ghost"
                  onClick={() => setTab("predict")}
                >
                  🎯 Créer un pronostic
                </button>
              </div>
            ) : (
              filteredHistory.map((pred) => (
                <PredictionCard
                  key={pred.id}
                  pred={pred}
                  onValidate={handleValidateMatch}
                  onDelete={handleDeleteMatch}
                />
              ))
            )}
          </div>
        )}

        {/* ======================================================
            ONGLET MÉMOIRE PROFONDE, DIAGNOSTIC ERREURS & AUTO-IA
           ====================================================== */}
        {tab === "stats" && (
          <div>
            {/* Bannière Centre Neuronal d'Auto-Amélioration Continue */}
            <div
              className="fai-panel"
              style={{
                borderColor: "rgba(0, 229, 255, 0.45)",
                background:
                  "linear-gradient(135deg, rgba(10,16,44,0.96), rgba(20,16,54,0.94))",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 14,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div className="fai-section-title" style={{ marginBottom: 4 }}>
                    <span>🧬 Centre Neuronal d&apos;Auto-Amélioration Continue — Génération #{genNumber}</span>
                  </div>
                  <p style={{ fontSize: 12.5, color: "#cbd2f5", maxWidth: 600 }}>
                    Les résultats officiels alimentent les profils d&apos;équipes et l&apos;apprentissage
                    rétrospectif. La performance mesurée est séparée : elle ne compte que les
                    pronostics enregistrés avant le coup d&apos;envoi puis reliés à un score officiel;
                    un rejeu historique ne prouve pas une performance future.
                  </p>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="fai-btn-primary"
                    style={{ width: "auto" }}
                    onClick={handleManualSelfEvolution}
                  >
                    ⚡ Optimiser l&apos;IA Maintenant (Multi-Époques)
                  </button>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    onClick={() => ingestFinishedMatches(false)}
                  >
                    📡 Apprendre des Vrais Matchs Terminés
                  </button>
                </div>
              </div>
            </div>

            {/* Indicateurs de performance prospective et apprentissage distinct */}
            <div className="fai-stats-grid">
              <div className="fai-stat-card">
                <div className="fai-kpi-lbl">Performance 1X2 officielle</div>
                <div
                  className="fai-kpi-val"
                  style={{ fontSize: 28, marginTop: 6, color: "#00e676" }}
                >
                  {acc !== null ? `${acc}%` : "—"}
                </div>
                <div style={{ fontSize: 11, color: "#7f89b2", marginTop: 4 }}>
                  {modelState.metrics.correct} / {modelState.metrics.total} pronostics évalués • minimum {MIN_PERFORMANCE_SAMPLE}
                </div>
              </div>

              <div className="fai-stat-card">
                <div className="fai-kpi-lbl">Réussite des marchés</div>
                <div
                  className="fai-kpi-val"
                  style={{ fontSize: 28, marginTop: 6, color: "#00e5ff" }}
                >
                  {modelState.metrics.marketAccuracyPct !== null
                    ? `${modelState.metrics.marketAccuracyPct}%`
                    : "—"}
                </div>
                <div style={{ fontSize: 11, color: "#7f89b2", marginTop: 4 }}>
                  {modelState.metrics.marketCorrect} / {modelState.metrics.total} sélections pré-match officielles
                </div>
              </div>

              <div className="fai-stat-card">
                <div className="fai-kpi-lbl">Brier Score pré-match (n ≥ {MIN_PERFORMANCE_SAMPLE})</div>
                <div
                  className="fai-kpi-val"
                  style={{ fontSize: 28, marginTop: 6, color: "#9d7bff" }}
                >
                  {modelState.metrics.brierScore !== null
                    ? modelState.metrics.brierScore.toFixed(3)
                    : "—"}
                </div>
                <div style={{ fontSize: 11, color: "#7f89b2", marginTop: 4 }}>
                  Calculé uniquement sur les prévisions officiellement évaluées
                </div>
              </div>

              <div className="fai-stat-card">
                <div className="fai-kpi-lbl">Écarts du rejeu historique</div>
                <div
                  className="fai-kpi-val"
                  style={{ fontSize: 28, marginTop: 6, color: "#ffea00" }}
                >
                  {modelState.errorJournal.length}
                </div>
                <div style={{ fontSize: 11, color: "#7f89b2", marginTop: 4 }}>
                  Analyse rétrospective; distincte du taux mesuré ci-dessus
                </div>
              </div>
            </div>

            <div className="fai-panel" style={{ display: "grid", gap: 8 }}>
              <div className="fai-section-title">
                <span>📚 Volume d&apos;apprentissage (distinct de la performance)</span>
              </div>
              <div className="fai-stats-grid" style={{ marginBottom: 0 }}>
                <div className="fai-stat-card">
                  <div className="fai-kpi-lbl">Résultats officiels intégrés</div>
                  <div className="fai-kpi-val" style={{ marginTop: 6, color: "#00e676" }}>
                    {modelState.learning.officialResults}
                  </div>
                </div>
                <div className="fai-stat-card">
                  <div className="fai-kpi-lbl">Saisies / ancien historique</div>
                  <div className="fai-kpi-val" style={{ marginTop: 6, color: "#ffea00" }}>
                    {modelState.learning.unverifiedOrLegacyResults}
                  </div>
                </div>
                <div className="fai-stat-card">
                  <div className="fai-kpi-lbl">Équipes avec résultats officiels</div>
                  <div className="fai-kpi-val" style={{ marginTop: 6, color: "#00e5ff" }}>
                    {modelState.learning.teamsWithOfficialResults}
                  </div>
                </div>
                <div className="fai-stat-card">
                  <div className="fai-kpi-lbl">Pronostics mesurables</div>
                  <div className="fai-kpi-val" style={{ marginTop: 6, color: "#9d7bff" }}>
                    {modelState.metrics.total} / {MIN_PERFORMANCE_SAMPLE}
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 11, color: "#7f89b2" }}>
                Les lignes « saisies / ancien historique » peuvent contribuer au modèle, mais ne sont
                ni annoncées comme résultats officiels ni incluses dans la performance mesurée.
              </p>
            </div>

            {/* Rejeu historique d'apprentissage + métriques pré-match vérifiées */}
            <div className="fai-grid-2">
              <div className="fai-panel">
                <div className="fai-section-title">
                  <span>⚙️ Hyperparamètres Auto-Calibrés (Génération #{genNumber})</span>
                </div>
                {[
                  [
                    "Poids Modèle Poisson Dixon-Coles",
                    `${Math.round(modelState.hyper.dcWeight * 100)}%`,
                    modelState.hyper.dcWeight * 100,
                    "#00e5ff",
                  ],
                  [
                    "Sensibilité Match Nul (Draw Scale)",
                    `×${modelState.hyper.drawScale.toFixed(3)}`,
                    (modelState.hyper.drawScale / 1.4) * 100,
                    "#9d7bff",
                  ],
                  [
                    "Coefficient Avantage Domicile",
                    `×${modelState.hyper.homeAdvScale.toFixed(3)}`,
                    (modelState.hyper.homeAdvScale / 1.35) * 100,
                    "#00e676",
                  ],
                  [
                    "Température Échelle Elo",
                    `×${(modelState.hyper.eloTemperature || 1).toFixed(3)}`,
                    ((modelState.hyper.eloTemperature || 1) / 1.2) * 100,
                    "#ffea00",
                  ],
                ].map(([label, textVal, barPct, color]) => (
                  <div key={label} style={{ marginBottom: 12 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ color: "#cbd2f5" }}>{label}</span>
                      <strong style={{ fontFamily: "var(--font-mono)", color }}>{textVal}</strong>
                    </div>
                    <div style={{ height: 7, background: "#141836", borderRadius: 4 }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(100, barPct)}%`,
                          background: color,
                          borderRadius: 4,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="fai-panel">
                <div className="fai-section-title">
                  <span>📈 Rejeu historique d&apos;apprentissage (non prospectif)</span>
                </div>
                <LearningCurveChart curve={modelState.learningCurve} />
                {Object.values(modelState.metrics.buckets).map((b) => {
                  const pct = b.total > 0 ? Math.round((b.correct / b.total) * 100) : 0;
                  return (
                    <div key={b.label} style={{ marginBottom: 10 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 12,
                          marginBottom: 4,
                        }}
                      >
                        <span>{b.label}</span>
                        <strong style={{ fontFamily: "var(--font-mono)" }}>
                          {b.total > 0 ? `${pct}% (${b.correct}/${b.total})` : "0 match"}
                        </strong>
                      </div>
                      <div style={{ height: 6, background: "#141836", borderRadius: 4 }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${pct}%`,
                            background: "linear-gradient(90deg, #00e5ff, #00e676)",
                            borderRadius: 4,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Journal Post-Mortem des Erreurs & Leçons Retenues par l'IA */}
            <div className="fai-panel">
              <div className="fai-section-title">
                <span>🔬 Journal d&apos;Autopsie des Erreurs &amp; Correctifs Appris par l&apos;IA</span>
                <span style={{ color: "#ffea00" }}>
                  {modelState.errorJournal.length} leçon(s) active(s)
                </span>
              </div>

              {modelState.errorJournal.length === 0 ? (
                <p style={{ fontSize: 13, color: "#8e98c2" }}>
                  Aucune erreur n&apos;est documentée pour le moment. L&apos;analyse ne commence qu&apos;à partir des résultats intégrés; les exemples de calibration historiques ne sont pas présentés comme des matchs réels.
                </p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {modelState.errorJournal.slice(0, 8).map((errItem) => (
                    <div
                      key={errItem.id}
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        background: "#080a1c",
                        borderLeft: `4px solid ${errItem.diagnosis.color}`,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                          fontSize: 12.5,
                          marginBottom: 4,
                        }}
                      >
                        <strong>
                          {errItem.matchTitle} ({errItem.scoreText}) —{" "}
                          <span style={{ color: errItem.diagnosis.color }}>
                            {errItem.diagnosis.title}
                          </span>
                        </strong>
                        <span style={{ color: "#8e98c2", fontSize: 11 }}>
                          Prédit : {errItem.predictedOutcome} ({errItem.predictedPct}%) → Réel :{" "}
                          {errItem.actualOutcome}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: "#9aa3c7" }}>
                        🧠 <strong>Correctif mémorisé :</strong> {errItem.diagnosis.lesson}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Classement dynamique des équipes apprises */}
            <div className="fai-panel">
              <div className="fai-section-title">
                <span>🏆 Classement Elo Dynamique &amp; Biais Spécifiques Appris par Club</span>
                <span style={{ color: "#7f89b2" }}>{learnedTeamsList.length} clubs actifs</span>
              </div>

              {learnedTeamsList.length === 0 ? (
                <p style={{ fontSize: 13, color: "#8e98c2" }}>
                  Aucun résultat n&apos;est encore intégré au classement. Importez ou auto-apprenez des scores officiels vérifiés pour construire les profils d&apos;équipe.
                </p>
              ) : (
                <div className="fai-table-wrap">
                  <table className="fai-table">
                    <thead>
                      <tr>
                        <th>Équipe</th>
                        <th>MJ</th>
                        <th>Bilan</th>
                        <th>Buts</th>
                        <th>Forme</th>
                        <th>Affinité Nul</th>
                        <th>Elo Actuel (Δ)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {learnedTeamsList.slice(0, 20).map((t) => (
                        <tr key={t.key}>
                          <td style={{ fontWeight: 700 }}>{t.name}</td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>{t.games}</td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {t.wins}V-{t.draws}N-{t.losses}D
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {t.goalsFor}:{t.goalsAgainst}
                          </td>
                          <td>
                            <FormBadges form={t.form} />
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                            ×{t.drawAffinity.toFixed(2)}
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)", fontWeight: 800 }}>
                            {Math.round(t.elo)}{" "}
                            <span
                              style={{
                                fontSize: 11,
                                color: t.eloDelta >= 0 ? "#00e676" : "#ff3d5a",
                              }}
                            >
                              ({t.eloDelta >= 0 ? "+" : ""}
                              {t.eloDelta})
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Synchronisation Cloud Firebase */}
            <div className="fai-panel">
              <div className="fai-section-title">
                <span>☁️ Synchronisation Cloud Firebase (Multi-Appareils)</span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr",
                  gap: 10,
                  marginBottom: 12,
                }}
              >
                <input
                  className="fai-input"
                  placeholder="https://votre-projet-default-rtdb.firebaseio.com"
                  value={cloudCfg.databaseUrl}
                  onChange={(e) =>
                    setCloudCfg((prev) => ({ ...prev, databaseUrl: e.target.value }))
                  }
                />
                <input
                  className="fai-input"
                  placeholder="Code coffre secret >= 8 car. (ex: coffre-abidjan-2026)"
                  value={cloudCfg.syncRoom}
                  onChange={(e) =>
                    setCloudCfg((prev) => ({ ...prev, syncRoom: e.target.value }))
                  }
                />
                <input
                  className="fai-input"
                  type="password"
                  placeholder="🔐 Mot de passe secret E2EE AES-256 (différent du coffre !)"
                  value={cloudCfg.encryptionPassphrase || ""}
                  onChange={(e) =>
                    setCloudCfg((prev) => ({ ...prev, encryptionPassphrase: e.target.value }))
                  }
                />
                <input
                  className="fai-input"
                  type="password"
                  placeholder="Jeton Auth Firebase optionnel (?auth=...)"
                  value={cloudCfg.authToken || ""}
                  onChange={(e) =>
                    setCloudCfg((prev) => ({ ...prev, authToken: e.target.value }))
                  }
                />
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="fai-btn-secondary"
                  disabled={cloudBusy || !cloudCfg.databaseUrl.trim()}
                  onClick={handlePushCloud}
                >
                  ☁️ Envoyer vers Firebase Cloud
                </button>
                <button
                  type="button"
                  className="fai-btn-ghost"
                  disabled={cloudBusy || !cloudCfg.databaseUrl.trim()}
                  onClick={handlePullCloud}
                >
                  🔄 Récupérer depuis Firebase Cloud
                </button>
              </div>
            </div>

            {/* Administration Mémoire */}
            <div className="fai-panel">
              <div className="fai-section-title">
                <span>🛠️ Gestion &amp; Sauvegarde de la Mémoire IA</span>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  type="button"
                  className="fai-btn-secondary"
                  onClick={() => ingestFinishedMatches(false)}
                >
                  📡 Importer les scores officiels récents
                </button>
                <button type="button" className="fai-btn-ghost" onClick={handleExportJSON}>
                  📤 Exporter Mémoire (.json)
                </button>
                <button
                  type="button"
                  className="fai-btn-ghost"
                  onClick={() => fileInputRef.current?.click()}
                >
                  📥 Importer Mémoire (.json)
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={handleImportJSON}
                />

                {!confirmReset ? (
                  <button
                    type="button"
                    className="fai-btn-ghost"
                    style={{
                      color: "#ff3d5a",
                      borderColor: "rgba(255,61,90,0.4)",
                      marginLeft: "auto",
                    }}
                    onClick={() => setConfirmReset(true)}
                  >
                    🗑️ Réinitialiser la mémoire
                  </button>
                ) : (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
                    <span style={{ fontSize: 12, color: "#ff3d5a", fontWeight: 700 }}>
                      Confirmer l&apos;effacement ?
                    </span>
                    <button
                      type="button"
                      className="fai-btn-ghost"
                      style={{ background: "#ff3d5a", color: "#fff", borderColor: "#ff3d5a" }}
                      onClick={handleConfirmedReset}
                    >
                      Oui, tout effacer
                    </button>
                    <button
                      type="button"
                      className="fai-btn-ghost"
                      onClick={() => setConfirmReset(false)}
                    >
                      Annuler
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      <LearningPerformanceBubble
        metrics={modelState.metrics}
        learning={modelState.learning}
        generation={genNumber}
        onOpenHistory={() => setTab("history")}
      />

      {toast && <div className="fai-toast">{toast}</div>}
    </div>
  );
}
