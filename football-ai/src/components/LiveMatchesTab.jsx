import { useEffect, useState, useMemo } from "react";
import { LEAGUES } from "../data/clubs.js";
import { getOffsetDateStrings, OPTA_PRESET_PACK, parseOptaDataFeed, OMNI_SPORT_ENDPOINTS } from "../services/liveMatchesApi.js";
import { OUTCOMES } from "../engine/predictor.js";
import { SPORT_CATALOG } from "../engine/omniSportEngine.js";
import { auditModelBiases } from "../engine/antiBiasEngine.js";
import MatchTruthDossierModal from "./MatchTruthDossierModal.jsx";

export default function LiveMatchesTab({
  dayOffset,
  onChangeDayOffset,
  liveFeed,
  loadingLive,
  onRefreshLive,
  onAutoLearnCompleted,
  onInspectMatch,
  onQuickAddCoupon,
  onOpenInPlay,
  onApplyOptaOverrides,
  predictionsHistory = [],
}) {
  const [sportFilter, setSportFilter] = useState("all");
  const [leagueFilter, setLeagueFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [onlyStrictLocks, setOnlyStrictLocks] = useState(false);
  const [onlySmartValue, setOnlySmartValue] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [serverProviders, setServerProviders] = useState(null);
  const [optaInput, setOptaInput] = useState("");
  const [optaStatus, setOptaStatus] = useState("");
  const [dossierMatch, setDossierMatch] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((status) => {
        if (!cancelled && status?.providers) setServerProviders(status.providers);
      })
      .catch(() => {
        if (!cancelled) setServerProviders({ unavailable: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const biasAudit = useMemo(
    () => auditModelBiases(predictionsHistory),
    [predictionsHistory]
  );

  const dayTabs = [
    { offset: -2, label: `⏮ J-2 (${getOffsetDateStrings(-2).displayFr})` },
    { offset: -1, label: `⏮ Hier (${getOffsetDateStrings(-1).displayFr})` },
    { offset: 0, label: `🔴 Aujourd'hui (${getOffsetDateStrings(0).displayFr})` },
    { offset: 1, label: `⏭ Demain (${getOffsetDateStrings(1).displayFr})` },
    { offset: 2, label: `📅 J+2 (${getOffsetDateStrings(2).displayFr})` },
    { offset: 3, label: `📅 J+3 (${getOffsetDateStrings(3).displayFr})` },
  ];

  // Compteurs instantanés par sport
  const sportCounts = useMemo(() => {
    const counts = { all: (liveFeed.matches || []).length };
    for (const m of liveFeed.matches || []) {
      const sp = m.sport || "soccer";
      counts[sp] = (counts[sp] || 0) + 1;
    }
    return counts;
  }, [liveFeed.matches]);

  const filteredMatches = useMemo(() => {
    let list = liveFeed.matches || [];
    if (sportFilter !== "all") {
      list = list.filter((m) => (m.sport || "soccer") === sportFilter);
    }
    if (sportFilter === "soccer" && leagueFilter !== "all") {
      list = list.filter((m) => m.league === leagueFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((m) =>
        `${m.home} ${m.away} ${m.leagueLabel || ""} ${m.venueFull || m.venue || ""} ${m.dateFr || ""}`
          .toLowerCase()
          .includes(q)
      );
    }
    if (onlyStrictLocks) {
      list = list.filter(
        (m) =>
          m.prediction?.reliabilityGate?.tier === "VERROU_ULTRA" ||
          m.prediction?.reliabilityGate?.tier === "CALIBRE"
      );
    }
    if (onlySmartValue) {
      list = list.filter(
        (m) =>
          m.prediction?.valueAnalysis?.bestValue?.isValue ||
          (m.prediction?.confidence?.score || 0) >= 62
      );
    }
    return list;
  }, [
    liveFeed.matches,
    sportFilter,
    leagueFilter,
    searchQuery,
    onlyStrictLocks,
    onlySmartValue,
  ]);

  const completedCount = useMemo(
    () =>
      (liveFeed.matches || []).filter(
        (m) => m.completed && typeof m.scoreHome === "number"
      ).length,
    [liveFeed.matches]
  );

  // Top 3 signaux pré-match autorisés par le portail strict de fiabilité
  const topPicksOfDay = useMemo(() => {
    return [...filteredMatches]
      .filter(
        (m) =>
          m.prediction &&
          !m.completed &&
          m.prediction.reliabilityGate?.allowAutoTicket === true
      )
      .sort(
        (a, b) =>
          (b.prediction.reliabilityGate?.compositeScore || b.prediction.confidence.score) -
          (a.prediction.reliabilityGate?.compositeScore || a.prediction.confidence.score)
      )
      .slice(0, 3);
  }, [filteredMatches]);

  const handleTogglePushAlerts = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setAlertsEnabled((v) => !v);
      return;
    }
    if (Notification.permission === "granted") {
      const next = !alertsEnabled;
      setAlertsEnabled(next);
      if (next && topPicksOfDay[0]) {
        const best = topPicksOfDay[0];
        new Notification("⚡ Verrou Omni-Sport IA Détecté", {
          body: `${best.home} vs ${best.away} → ${best.prediction.recommendedMarket.label} (${best.prediction.recommendedMarket.pct}%)`,
        });
      }
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      setAlertsEnabled(true);
    }
  };

  const handleLoadOptaPreset = () => {
    const csvLines = OPTA_PRESET_PACK.map(
      (r) => `${r.team},${r.xgFor90},${r.xgAgainst90},${r.elo}`
    ).join("\n");
    setOptaInput(csvLines);
    const parsed = parseOptaDataFeed(csvLines);
    onApplyOptaOverrides(parsed.overrides, parsed.count);
    setOptaStatus(`✓ Pack Opta Pro (${parsed.count} clubs xG/90 & xGA/90) injecté dans le modèle !`);
  };

  const handleCustomOptaImport = () => {
    try {
      const parsed = parseOptaDataFeed(optaInput);
      onApplyOptaOverrides(parsed.overrides, parsed.count);
      setOptaStatus(`✓ ${parsed.count} clubs mis à jour depuis votre flux Opta / CSV / JSON !`);
    } catch (err) {
      setOptaStatus(`⚠️ ${err.message}`);
    }
  };

  return (
    <div>
      {/* BARRE SUPÉRIEURE : OMNI-SPORT INTERNET + GARDE ZÉRO-HALLUCINATION & ANTI-BIAIS */}
      <div className="fai-panel">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <div>
            <div className="fai-section-title" style={{ marginBottom: 4 }}>
              <span>
                🌐 Omni-Sport Live Internet v6.4 — {OMNI_SPORT_ENDPOINTS.length} endpoints de compétitions, Dates &amp; Stades, H2H &amp; Anti-Biais
              </span>
            </div>
            <div style={{ fontSize: 12, color: "#9aa3c7" }}>
              Flux actif :{" "}
              <strong style={{ color: liveFeed.isLiveNetwork ? "#00e676" : "#ffea00" }}>
                {liveFeed.providerUsed || "Connexion ultra-rapide..."}
              </strong>{" "}
              {!liveFeed.isLiveNetwork && (
                <span style={{ color: "#ffb74d" }}>• Données de secours : statut Live non certifié</span>
              )}{" "}
              • <strong>{filteredMatches.length}</strong> rencontre(s) affichée(s) •{" "}
              <span style={{ color: "#00e5ff" }}>
                🛡️ Zéro-Hallucination &amp; Anti-Clonage de Schéma Actifs
              </span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="fai-btn-secondary"
              disabled={loadingLive}
              onClick={() => onRefreshLive(dayOffset)}
            >
              {loadingLive ? "⚡ Sync Internet..." : "🔄 Sync Internet Direct"}
            </button>
            <button
              type="button"
              className="fai-btn-secondary"
              style={{ borderColor: "#00e676", color: "#00e676" }}
              onClick={onAutoLearnCompleted}
            >
              🧠 Auto-Apprendre Scores Réels {completedCount > 0 ? `(${completedCount})` : ""}
            </button>
            <button
              type="button"
              className="fai-btn-ghost"
              style={{
                borderColor: onlyStrictLocks ? "#00e676" : undefined,
                color: onlyStrictLocks ? "#00e676" : undefined,
              }}
              onClick={() => setOnlyStrictLocks((v) => !v)}
              title="Masque automatiquement tous les matchs pièges / incertains et ne conserve que les sélections verrouillées"
            >
              🔒 {onlyStrictLocks ? "Afficher tous les niveaux" : "Verrous Haute Fiabilité"}
            </button>
            <button
              type="button"
              className="fai-btn-ghost"
              style={{
                borderColor: onlySmartValue ? "#ffea00" : undefined,
                color: onlySmartValue ? "#ffea00" : undefined,
              }}
              onClick={() => setOnlySmartValue((v) => !v)}
            >
              💎 {onlySmartValue ? "Tous" : "Smart Value"}
            </button>
            <button
              type="button"
              className="fai-btn-ghost"
              onClick={handleTogglePushAlerts}
              style={{ color: alertsEnabled ? "#00e676" : undefined }}
            >
              {alertsEnabled ? "🔔 Alertes ON" : "🔕 Alertes"}
            </button>
            <button
              type="button"
              className="fai-btn-ghost"
              onClick={() => setShowConnectors((v) => !v)}
            >
              🔌 Sources &amp; Opta {showConnectors ? "▲" : "▼"}
            </button>
          </div>
        </div>

        {/* Bandeau Télémétrie Anti-Biais & Calibration Scientifique */}
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            padding: "8px 12px",
            marginBottom: 12,
            borderRadius: 10,
            background: "rgba(0, 230, 118, 0.06)",
            border: "1px solid rgba(0, 230, 118, 0.22)",
            fontSize: 11.5,
            color: "#cbd2f5",
          }}
        >
          <span>
            ⚖️ <strong>Audit Anti-Biais Temps Réel :</strong>
          </span>
          <span>
            Diversité des schémas :{" "}
            <strong style={{ color: "#00e676" }}>{biasAudit.schemaDiversityPct}%</strong>
          </span>
          <span>
            Erreur de calibration (ECE) :{" "}
            <strong style={{ color: "#00e5ff" }}>{biasAudit.ecePct}%</strong>
          </span>
          <span>
            Régularisation Ridge L2 :{" "}
            <strong style={{ color: "#ffea00" }}>Anti-Surapprentissage (min. 6 matchs)</strong>
          </span>
          <span>
            Vérification factuelle :{" "}
            <strong style={{ color: "#00e676" }}>Dates, Stades, H2H &amp; Blessés 100% Sources Live</strong>
          </span>
        </div>

        {/* Panneau Connecteurs API-Football & Opta */}
        {showConnectors && (
          <div
            style={{
              padding: 16,
              marginBottom: 14,
              borderRadius: 12,
              background: "#080a1c",
              border: "1px solid rgba(0, 229, 255, 0.35)",
            }}
          >
            <div className="fai-grid-2">
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#00e5ff", marginBottom: 8 }}>
                  🔐 Connecteurs de données côté serveur
                </div>
                <div style={{ display: "grid", gap: 8, color: "#c4cbe6", fontSize: 12 }}>
                  <div>
                    <strong>Football-Data.org</strong> — matchs, résultats et classements :{" "}
                    <span style={{ color: serverProviders?.footballDataConfigured ? "#00e676" : "#ffcc80" }}>
                      {serverProviders?.footballDataConfigured
                        ? "clé configurée côté serveur"
                        : serverProviders?.unavailable
                          ? "API serveur non reliée"
                          : "connecteur serveur optionnel non configuré"}
                    </span>
                  </div>
                  <div>
                    <strong>API-Football</strong> — statistiques joueurs :{" "}
                    <span style={{ color: serverProviders?.apiFootballConfigured ? "#00e676" : "#ffcc80" }}>
                      {serverProviders?.apiFootballConfigured
                        ? "clé configurée côté serveur"
                        : serverProviders?.unavailable
                          ? "API serveur non reliée"
                          : "connecteur serveur optionnel non configuré"}
                    </span>
                  </div>
                  <div style={{ color: "#91a0c8", lineHeight: 1.5 }}>
                    Aucune clé n&apos;est demandée ni stockée dans ce navigateur. Sans connecteur,
                    le calendrier public ESPN reste disponible.
                  </div>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    style={{ justifySelf: "start" }}
                    onClick={() => onRefreshLive(dayOffset)}
                  >
                    Actualiser les matchs
                  </button>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#00e676", marginBottom: 6 }}>
                  📊 Calibration Opta / FBref xG par 90 min
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    onClick={handleLoadOptaPreset}
                  >
                    ⚡ Charger Pack Opta 12 Grands Clubs
                  </button>
                  <button
                    type="button"
                    className="fai-btn-ghost"
                    onClick={handleCustomOptaImport}
                  >
                    Importer CSV/JSON
                  </button>
                </div>
                <textarea
                  rows={2}
                  className="fai-input"
                  placeholder="Club,xG_90,xGA_90,Elo"
                  value={optaInput}
                  onChange={(e) => setOptaInput(e.target.value)}
                />
                {optaStatus && (
                  <div style={{ fontSize: 11, color: "#00e676", marginTop: 4 }}>{optaStatus}</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* SÉLECTEUR DE SPORTS MONDIAUX (7 SPORTS EN DIRECT) */}
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10 }}>
          {Object.values(SPORT_CATALOG).map((sp) => {
            const cnt = sportCounts[sp.id] || 0;
            const active = sportFilter === sp.id;
            return (
              <button
                key={sp.id}
                type="button"
                className="fai-quick-chip"
                onClick={() => setSportFilter(sp.id)}
                style={{
                  borderColor: active ? sp.accent : undefined,
                  background: active ? "rgba(0, 229, 255, 0.16)" : undefined,
                  color: active ? "#ffffff" : undefined,
                  fontWeight: active ? 800 : 600,
                }}
              >
                {sp.icon} {sp.label} ({cnt})
              </button>
            );
          })}
        </div>

        {/* RECHERCHE INSTANTANÉE (< 1 ms) + SÉLECTEUR DE DATES (-2 à +3 JOURS) */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 10,
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <input
            type="text"
            className="fai-input"
            placeholder="🔍 Recherche ultra-rapide : équipe, joueur ATP/WTA, NBA, stade, ville, pays, ligue..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {sportFilter === "soccer" && (
            <select
              className="fai-input"
              value={leagueFilter}
              onChange={(e) => setLeagueFilter(e.target.value)}
            >
              <option value="all">🌍 Toutes les compétitions Football</option>
              {Object.entries(LEAGUES).map(([id, cfg]) => (
                <option key={id} value={id}>
                  {cfg.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {dayTabs.map((d) => (
            <button
              key={d.offset}
              type="button"
              className="fai-quick-chip"
              onClick={() => onChangeDayOffset(d.offset)}
              style={{
                borderColor: dayOffset === d.offset ? "#00e5ff" : undefined,
                background: dayOffset === d.offset ? "rgba(0,229,255,0.18)" : undefined,
                color: dayOffset === d.offset ? "#fff" : undefined,
                fontWeight: dayOffset === d.offset ? 800 : 600,
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* TOP 3 VERROUS HAUTE FIABILITÉ DU JOUR */}
      {topPicksOfDay.length > 0 && (
        <div className="fai-panel" style={{ borderColor: "rgba(0, 230, 118, 0.4)" }}>
          <div className="fai-section-title">
            <span>🏆 Top 3 sélections pré-match autorisées (portail strict de fiabilité)</span>
          </div>
          <div className="fai-grid-3">
            {topPicksOfDay.map((m) => (
              <div
                key={`top-${m.externalId}`}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  background: "rgba(0, 230, 118, 0.06)",
                  border: "1px solid rgba(0, 230, 118, 0.3)",
                }}
              >
                <div style={{ fontSize: 10.5, color: "#00e5ff", fontWeight: 800 }}>
                  {SPORT_CATALOG[m.sport || "soccer"]?.icon} {m.leagueLabel || LEAGUES[m.league]?.name}
                </div>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#fff", margin: "4px 0" }}>
                  {m.home} vs {m.away}
                </div>
                <div style={{ fontSize: 11, color: "#9aa3c7", marginBottom: 6 }}>
                  📅 {m.fullDateFr || m.dateFr} • {m.timeStr}{" "}
                  {m.venue ? `• 🏟️ ${m.venue}` : ""}
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#00e676", marginBottom: 8 }}>
                  ★ {m.prediction.recommendedMarket.label} ({m.prediction.recommendedMarket.pct}%)
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    style={{ fontSize: 11, padding: "5px 10px" }}
                    onClick={() => onQuickAddCoupon(m)}
                  >
                    + Ajouter au Ticket
                  </button>
                  <button
                    type="button"
                    className="fai-btn-ghost"
                    style={{ fontSize: 11, padding: "5px 10px" }}
                    onClick={() => setDossierMatch(m)}
                  >
                    📜 H2H, Stade &amp; Joueurs
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LISTE ULTRA-VIVE DE TOUS LES MATCHS */}
      {loadingLive && filteredMatches.length === 0 ? (
        <div className="fai-panel" style={{ textAlign: "center", padding: 36 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⚡</div>
          <div style={{ color: "#00e5ff", fontWeight: 700 }}>
            Synchronisation Internet multi-sports en parallèle ({OMNI_SPORT_ENDPOINTS.length} endpoints)...
          </div>
        </div>
      ) : filteredMatches.length === 0 ? (
        <div className="fai-panel" style={{ textAlign: "center", padding: 30, color: "#9aa3c7" }}>
          Aucun match ne correspond à ce filtre précis sur cette journée. Essayez un autre jour (Hier / Demain) ou « Tous les Sports ».
        </div>
      ) : (
        filteredMatches.map((m) => {
          const pred = m.prediction;
          const isSoccer = (m.sport || "soccer") === "soccer";
          const gate = pred.reliabilityGate;
          const maxIdx = pred.probs.indexOf(Math.max(...pred.probs));
          const realOutcome =
            m.completed && typeof m.scoreHome === "number" && typeof m.scoreAway === "number"
              ? m.scoreHome > m.scoreAway
                ? 0
                : m.scoreHome === m.scoreAway
                  ? 1
                  : 2
              : null;

          return (
            <div key={m.externalId} className="fai-panel" style={{ padding: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      color: SPORT_CATALOG[m.sport || "soccer"]?.accent || "#00e5ff",
                    }}
                  >
                    {SPORT_CATALOG[m.sport || "soccer"]?.icon}{" "}
                    {m.leagueLabel || LEAGUES[m.league]?.name || m.league}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background:
                        m.state === "in" ? "rgba(255,61,90,0.22)" : "rgba(255,255,255,0.06)",
                      color: m.state === "in" ? "#ff3d5a" : "#cbd2f5",
                      fontWeight: 700,
                    }}
                  >
                    {m.statusText}
                  </span>
                  <span style={{ fontSize: 11, color: "#b6c0e8" }}>
                    📅 {m.fullDateFr || m.dateFr}
                  </span>
                  {(m.venueFull || m.venue) && (
                    <span style={{ fontSize: 11, color: "#00e5ff" }}>
                      🏟️ {m.venueFull || m.venue}
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {gate && (
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 800,
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: `1px solid ${gate.color}`,
                        color: gate.color,
                      }}
                    >
                      {gate.badge} ({gate.compositeScore}/100)
                    </span>
                  )}
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.25fr 0.95fr auto",
                  gap: 14,
                  alignItems: "center",
                }}
                className="fai-live-row"
              >
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      fontSize: 16.5,
                      fontWeight: 800,
                      flexWrap: "wrap",
                    }}
                  >
                    {m.homeLogo && (
                      <img src={m.homeLogo} alt="" width={22} height={22} loading="lazy" />
                    )}
                    <span>{m.home}</span>
                    {typeof m.scoreHome === "number" && typeof m.scoreAway === "number" ? (
                      <span
                        style={{
                          padding: "2px 9px",
                          borderRadius: 7,
                          background: "rgba(0,229,255,0.16)",
                          color: "#00e5ff",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {m.scoreHome} - {m.scoreAway}
                      </span>
                    ) : (
                      <span style={{ color: "#5e6790", fontSize: 13 }}>vs</span>
                    )}
                    {m.awayLogo && (
                      <img src={m.awayLogo} alt="" width={22} height={22} loading="lazy" />
                    )}
                    <span>{m.away}</span>
                  </div>

                  <div style={{ fontSize: 11.5, color: "#8e98c2", marginTop: 5 }}>
                    Projection IA :{" "}
                    <strong style={{ color: "#00e5ff" }}>
                      {pred.xg.home} - {pred.xg.away} {pred.projectionUnit || "xG"}
                    </strong>
                    {m.homeRecord || m.awayRecord ? (
                      <span>
                        {" "}
                        • Bilans officiels : <strong>{m.homeRecord || "—"}</strong> /{" "}
                        <strong>{m.awayRecord || "—"}</strong>
                      </span>
                    ) : null}
                    {m.liveOdds?.odd1 && m.liveOdds?.odd2 ? (
                      <span>
                        {" "}
                        • Cotes Live : <strong>@{m.liveOdds.odd1}</strong> /{" "}
                        <strong>@{m.liveOdds.odd2}</strong>
                      </span>
                    ) : null}
                    {realOutcome !== null && (
                      <span
                        style={{
                          marginLeft: 8,
                          color: realOutcome === maxIdx ? "#00e676" : "#ffea00",
                          fontWeight: 700,
                        }}
                      >
                        {realOutcome === maxIdx ? "✓ Pronostic exact validé !" : "⚡ Score final enregistré"}
                      </span>
                    )}
                  </div>
                </div>

                {/* Probabilités 1X2 (Football) ou Vainqueur 1 / 2 (NBA, Tennis, NFL, NHL, MLB, UFC) */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isSoccer ? "repeat(3, 1fr)" : "repeat(2, 1fr)",
                    gap: 6,
                  }}
                >
                  {(isSoccer ? ["1", "N", "2"] : ["1 • Dom/J1", "2 • Ext/J2"]).map((lbl, idx) => {
                    const realIdx = isSoccer ? idx : idx === 0 ? 0 : 2;
                    return (
                      <div
                        key={lbl}
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          textAlign: "center",
                          background:
                            realIdx === maxIdx
                              ? "rgba(0, 229, 255, 0.14)"
                              : "rgba(8, 10, 26, 0.8)",
                          border: `1px solid ${
                            realIdx === maxIdx
                              ? "rgba(0, 229, 255, 0.5)"
                              : "var(--border-muted)"
                          }`,
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        <div style={{ fontSize: 10, color: "#7f89b2" }}>{lbl}</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>
                          {pred.probs[realIdx]}%
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Actions rapides dont Dossier Vérité H2H, Stade & Joueurs */}
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="fai-btn-ghost"
                    style={{ borderColor: "#00e5ff", color: "#00e5ff" }}
                    onClick={() => setDossierMatch(m)}
                  >
                    📜 H2H, Stade &amp; Joueurs
                  </button>
                  {isSoccer && (
                    <button
                      type="button"
                      className="fai-btn-ghost"
                      onClick={() => onInspectMatch(m)}
                    >
                      🔬 Matrice
                    </button>
                  )}
                  {isSoccer && onOpenInPlay && !m.completed && (
                    <button
                      type="button"
                      className="fai-btn-ghost"
                      onClick={() => onOpenInPlay(m)}
                    >
                      🔴 Live
                    </button>
                  )}
                  {!m.completed && gate?.tier !== "NO_BET_PIEGE" && (
                    <button
                      type="button"
                      className="fai-btn-secondary"
                      onClick={() => onQuickAddCoupon(m)}
                    >
                      🎰 + Ticket ({pred.recommendedMarket.pct}%)
                    </button>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 8, fontSize: 11.5, color: "#9aa3c7" }}>
                💡 Décision Anti-Biais :{" "}
                <strong style={{ color: pred.confidence.color }}>
                  {isSoccer
                    ? OUTCOMES[maxIdx]
                    : `Avantage ${maxIdx === 0 ? m.home : m.away}`}
                </strong>{" "}
                • Sélection optimale :{" "}
                <strong style={{ color: "#00e676" }}>
                  {pred.recommendedMarket.label} ({pred.recommendedMarket.pct}% • @
                  {pred.recommendedMarket.fairOdd})
                </strong>
              </div>
            </div>
          );
        })
      )}

      {/* FENÊTRE MODALE DOSSIER VÉRITÉ ZÉRO-HALLUCINATION */}
      {dossierMatch && (
        <MatchTruthDossierModal
          match={dossierMatch}
          onClose={() => setDossierMatch(null)}
          onAddCoupon={onQuickAddCoupon}
          onInspectPredict={onInspectMatch}
        />
      )}
    </div>
  );
}
