import { useCallback, useEffect, useState } from "react";
import {
  fetchVerifiedMatchVideosFromInternet,
  analyzeOfficialInternetMatchClip,
  analyzeLiveMatchTelemetryWithoutClip,
  analyzeLiveScreenStreamBurst,
  analyzeMatchVideoFile,
  buildSyntheticVideoDemo,
} from "../engine/videoAnalyzer.js";

export default function VideoAnalysisTab({
  activeHome,
  activeAway,
  liveMatches = [],
  videoInsight,
  onSelectTargetMatch,
  onVideoInsightReady,
  onClearVideoInsight,
  onApplyAndGoPredict,
  onAddLiveBetToCoupon,
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  const [discoveryState, setDiscoveryState] = useState({
    loading: false,
    resolvedMatch: null,
    isTargetLiveNow: false,
    isTargetFinished: false,
    preKickoff: false,
    verifiedClips: [],
    espnSummaryJson: null,
    auditLog: [],
    currentlyLiveMatches: [],
    availableLiveVideoCatalog: [],
  });
  const [selectedClipId, setSelectedClipId] = useState("");
  const [autoRefreshLive, setAutoRefreshLive] = useState(true);

  const runLiveVideoDiscovery = useCallback(
    async (overrideHome, overrideAway) => {
      const h = overrideHome || activeHome;
      const a = overrideAway || activeAway;
      setDiscoveryState((prev) => ({ ...prev, loading: true }));
      setErrMsg("");

      try {
        const res = await fetchVerifiedMatchVideosFromInternet(
          { home: h, away: a },
          liveMatches,
          { liveOnly: true }
        );

        // Si le match sélectionné n'est pas en cours MAIS qu'il existe un match 🔴 EN COURS maintenant,
        // basculer automatiquement sur le 1er match réellement EN DIRECT afin de permettre le pari Live immédiat !
        if (
          !res.isTargetLiveNow &&
          !overrideHome &&
          res.currentlyLiveMatches.length > 0
        ) {
          const firstLive = res.currentlyLiveMatches[0];
          if (onSelectTargetMatch) {
            onSelectTargetMatch(firstLive.home, firstLive.away);
          }
          const redirected = await fetchVerifiedMatchVideosFromInternet(
            firstLive,
            liveMatches,
            { liveOnly: true }
          );
          setDiscoveryState({ loading: false, ...redirected });
          if (redirected.verifiedClips.length > 0) {
            const clip0 = redirected.verifiedClips[0];
            setSelectedClipId(clip0.id);
            const insight = await analyzeOfficialInternetMatchClip(
              clip0,
              redirected.resolvedMatch,
              redirected.espnSummaryJson,
              setProgress
            );
            onVideoInsightReady(insight);
          } else if (redirected.isTargetLiveNow && redirected.resolvedMatch) {
            const liveTelemetryInsight = analyzeLiveMatchTelemetryWithoutClip(
              redirected.resolvedMatch,
              redirected.espnSummaryJson,
              setProgress
            );
            onVideoInsightReady(liveTelemetryInsight);
          }
          return;
        }

        setDiscoveryState({ loading: false, ...res });
        if (res.verifiedClips.length > 0) {
          const bestClip = res.verifiedClips[0];
          setSelectedClipId(bestClip.id);
          setBusy(true);
          setProgress(25);
          const autoInsight = await analyzeOfficialInternetMatchClip(
            bestClip,
            res.resolvedMatch,
            res.espnSummaryJson,
            setProgress
          );
          onVideoInsightReady(autoInsight);
          setBusy(false);
        } else if (res.isTargetLiveNow && res.resolvedMatch) {
          const liveTelemetryInsight = analyzeLiveMatchTelemetryWithoutClip(
            res.resolvedMatch,
            res.espnSummaryJson,
            setProgress
          );
          onVideoInsightReady(liveTelemetryInsight);
        }
      } catch (e) {
        setBusy(false);
        setDiscoveryState((prev) => ({ ...prev, loading: false }));
        setErrMsg(e.message || "Erreur lors de la récupération du flux Live en cours.");
      }
    },
    [activeHome, activeAway, liveMatches, onSelectTargetMatch, onVideoInsightReady]
  );

  useEffect(() => {
    runLiveVideoDiscovery();
  }, [activeHome, activeAway]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rafraîchissement automatique toutes les 25 secondes tant que le direct est ouvert !
  useEffect(() => {
    if (!autoRefreshLive) return undefined;
    const id = setInterval(() => {
      runLiveVideoDiscovery(activeHome, activeAway);
    }, 25000);
    return () => clearInterval(id);
  }, [autoRefreshLive, activeHome, activeAway, runLiveVideoDiscovery]);

  const handleSelectVerifiedClip = async (clip) => {
    setSelectedClipId(clip.id);
    setBusy(true);
    setErrMsg("");
    setProgress(20);
    try {
      const res = await analyzeOfficialInternetMatchClip(
        clip,
        discoveryState.resolvedMatch || { home: activeHome, away: activeAway },
        discoveryState.espnSummaryJson,
        setProgress
      );
      onVideoInsightReady(res);
    } catch (err) {
      setErrMsg(err.message || "Impossible d'analyser cette séquence en direct.");
    }
    setBusy(false);
  };

  const handleCaptureLiveScreen = async () => {
    setBusy(true);
    setErrMsg("");
    setProgress(10);
    try {
      const target = discoveryState.resolvedMatch || {
        home: activeHome,
        away: activeAway,
        sport: "soccer",
        statusText: "EN DIRECT",
      };
      const res = await analyzeLiveScreenStreamBurst(target, setProgress);
      onVideoInsightReady(res);
    } catch (err) {
      setErrMsg(err.message || "Partage du flux direct annulé ou non détecté.");
    }
    setBusy(false);
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setProgress(5);
    setErrMsg("");
    try {
      const res = await analyzeMatchVideoFile(file, setProgress, activeHome, activeAway);
      onVideoInsightReady(res);
    } catch (err) {
      setErrMsg(err.message || "Fichier vidéo rejeté par le contrôle visuel.");
    }
    setBusy(false);
    e.target.value = "";
  };

  const activeClip =
    discoveryState.verifiedClips.find((c) => c.id === selectedClipId) ||
    discoveryState.verifiedClips[0] ||
    null;

  const liveRec = videoInsight?.liveBetRecommendation;
  const rm = discoveryState.resolvedMatch;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {/* EN-TÊTE STRICTEMENT EN DIRECT (AVANT LA FIN DU MATCH !) */}
      <section className="fai-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <div className="fai-card-title" style={{ marginBottom: 0 }}>
            🔴 ANALYSE VIDÉO &amp; ACTION EN DIRECT (UNIQUEMENT MATCHS EN COURS — AVANT FIN DU MATCH)
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                color: "#00e676",
                cursor: "pointer",
                background: "rgba(0, 230, 118, 0.1)",
                padding: "5px 10px",
                borderRadius: 999,
                border: "1px solid rgba(0, 230, 118, 0.35)",
              }}
            >
              <input
                type="checkbox"
                checked={autoRefreshLive}
                onChange={(e) => setAutoRefreshLive(e.target.checked)}
              />
              🔄 Direct Auto (25s)
            </label>
            <button
              type="button"
              className="fai-btn-chip"
              onClick={() => runLiveVideoDiscovery(activeHome, activeAway)}
              disabled={discoveryState.loading}
              style={{ borderColor: "#00e5ff", color: "#00e5ff", fontWeight: 700 }}
            >
              {discoveryState.loading ? "⏳ Scan Direct..." : "⚡ Actualiser le Direct"}
            </button>
          </div>
        </div>

        <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 14, lineHeight: 1.55 }}>
          Ce module ne retient <strong>STRICTEMENT QUE les rencontres EN COURS DE JEU (🔴 LIVE)</strong> — jamais les
          matchs terminés — afin que vous puissiez <strong>placer votre pari en direct avant le coup de sifflet final</strong>.
          Quintuple verrou actif : <strong>Bonnes équipes + Même catégorie (Pro A ≠ Féminines/U19) + Horaire Live exact</strong>.
        </p>

        {/* SÉLECTEUR EN 1 CLIC DES MATCHS ACTUELLEMENT EN DIRECT SUR LA PLANÈTE */}
        {discoveryState.currentlyLiveMatches.length > 0 && (
          <div
            style={{
              background: "rgba(239, 68, 68, 0.08)",
              border: "1px solid rgba(248, 113, 113, 0.35)",
              borderRadius: 12,
              padding: 12,
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 800, color: "#fca5a5", marginBottom: 8 }}>
              🔴 MATCHS OFFICIELLEMENT EN COURS EN CE MOMENT ({discoveryState.currentlyLiveMatches.length} OUVERTS AUX PARIS LIVE) :
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {discoveryState.currentlyLiveMatches.slice(0, 10).map((m) => {
                const isSelected =
                  rm?.externalId === m.externalId ||
                  (m.home === activeHome && m.away === activeAway);
                return (
                  <button
                    key={m.externalId}
                    type="button"
                    className="fai-btn-chip"
                    style={{
                      borderColor: isSelected ? "#00e676" : "rgba(248, 113, 113, 0.45)",
                      background: isSelected ? "rgba(0, 230, 118, 0.16)" : "rgba(15, 23, 42, 0.7)",
                      color: isSelected ? "#00e676" : "#f8fafc",
                      fontSize: 11.5,
                    }}
                    onClick={() => {
                      if (onSelectTargetMatch) onSelectTargetMatch(m.home, m.away);
                      runLiveVideoDiscovery(m.home, m.away);
                    }}
                  >
                    🔴 {m.home} {m.scoreHome ?? 0}-{m.scoreAway ?? 0} {m.away} ({m.statusText || "LIVE"})
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* BANDEAU STATUT DU MATCH SÉLECTIONNÉ */}
        <div
          style={{
            background: discoveryState.isTargetLiveNow
              ? "rgba(0, 230, 118, 0.08)"
              : "rgba(245, 158, 11, 0.09)",
            border: `1px solid ${
              discoveryState.isTargetLiveNow
                ? "rgba(0, 230, 118, 0.4)"
                : "rgba(245, 158, 11, 0.4)"
            }`,
            borderRadius: 12,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontWeight: 800, color: "#fff", fontSize: 14 }}>
              🎯 Match suivi :{" "}
              <span style={{ color: "#00e5ff" }}>
                {activeHome} {rm?.state === "in" ? `${rm.scoreHome ?? 0} - ${rm.scoreAway ?? 0}` : "vs"} {activeAway}
              </span>
              {rm?.statusText && (
                <span style={{ color: "#00e676", marginLeft: 8, fontSize: 12.5 }}>
                  • {rm.statusText}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 800,
                padding: "3px 10px",
                borderRadius: 999,
                background: discoveryState.isTargetLiveNow
                  ? "rgba(0, 230, 118, 0.18)"
                  : "rgba(245, 158, 11, 0.18)",
                color: discoveryState.isTargetLiveNow ? "#00e676" : "#fbbf24",
              }}
            >
              {discoveryState.isTargetLiveNow
                ? "🔴 EN COURS — PARIS LIVE OUVERTS !"
                : discoveryState.isTargetFinished
                  ? "🏁 TERMINÉ — REJETÉ POUR LE LIVE"
                  : "🕒 EN ATTENTE DU COUP D'ENVOI"}
            </div>
          </div>

          {/* LECTEUR VIDÉO DIRECT EN COURS */}
          {discoveryState.verifiedClips.length > 0 && activeClip && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 8 }}>
                <strong>📡 Flux Live Certifié :</strong> {activeClip.title} —{" "}
                <span style={{ color: "#00e676" }}>
                  ✅ {activeClip.verification?.videoDateFr} ({activeClip.provider})
                </span>
              </div>

              {activeClip.mp4Url ? (
                <video
                  key={activeClip.mp4Url}
                  src={activeClip.mp4Url}
                  poster={activeClip.thumbnail || undefined}
                  controls
                  playsInline
                  style={{
                    width: "100%",
                    maxHeight: 340,
                    borderRadius: 10,
                    background: "#000",
                    border: "1px solid rgba(0, 229, 255, 0.35)",
                  }}
                />
              ) : activeClip.embedSrc ? (
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    paddingTop: "56.25%",
                    borderRadius: 10,
                    overflow: "hidden",
                    border: "1px solid rgba(0, 229, 255, 0.35)",
                    background: "#000",
                  }}
                >
                  <iframe
                    src={activeClip.embedSrc}
                    title={activeClip.title}
                    sandbox="allow-scripts allow-same-origin allow-presentation"
                    allow="autoplay; fullscreen"
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      border: 0,
                    }}
                  />
                </div>
              ) : null}

              {discoveryState.verifiedClips.length > 1 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {discoveryState.verifiedClips.map((clip, idx) => (
                    <button
                      key={clip.id}
                      type="button"
                      className="fai-btn-chip"
                      style={{
                        borderColor: clip.id === activeClip.id ? "#00e676" : undefined,
                        color: clip.id === activeClip.id ? "#00e676" : undefined,
                        fontSize: 11.5,
                      }}
                      onClick={() => handleSelectVerifiedClip(clip)}
                    >
                      🎬 Action Live #{idx + 1} : {clip.title.slice(0, 40)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {discoveryState.auditLog.length > 0 && (
            <div
              style={{
                marginTop: 10,
                padding: "9px 11px",
                borderRadius: 8,
                background: "rgba(15, 23, 42, 0.72)",
                fontSize: 12,
                color: "#cbd5e1",
                lineHeight: 1.5,
              }}
            >
              {discoveryState.auditLog.map((line, i) => (
                <div key={i}>• {line}</div>
              ))}
            </div>
          )}
        </div>

        {/* CAPTURE DIRECTE D'UN ONGLET STREAM LIVE (BETCLIC TV / CANAL+ / BEIN / YOUTUBE LIVE) */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            className="fai-btn-primary"
            style={{ width: "auto", padding: "11px 18px", fontSize: 13 }}
            onClick={handleCaptureLiveScreen}
            disabled={busy}
          >
            📡 Capturer le Flux Vidéo Direct (Betclic TV / Canal+ / Onglet Live)
          </button>

          <label
            style={{
              cursor: "pointer",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px dashed rgba(0, 229, 255, 0.45)",
              color: "#94a3b8",
              fontSize: 12.5,
            }}
          >
            📁 Extrait vidéo Live local (.mp4 / .webm)
            <input
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              style={{ display: "none" }}
              disabled={busy}
            />
          </label>

          <button
            type="button"
            className="fai-btn-chip"
            onClick={() => onVideoInsightReady(buildSyntheticVideoDemo(activeHome, activeAway))}
            disabled={busy}
          >
            🧪 Tester Simulation Live Vision IA
          </button>

          {videoInsight && (
            <button
              type="button"
              className="fai-btn-chip"
              style={{ borderColor: "#ff5252", color: "#ff8a80" }}
              onClick={onClearVideoInsight}
            >
              ✕ Effacer
            </button>
          )}
        </div>

        {busy && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12.5, color: "#00e5ff", marginBottom: 5 }}>
              Analyse temps réel des images &amp; calcul du Pari Live ({progress}%)...
            </div>
            <div style={{ height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "linear-gradient(90deg, #00e5ff, #00e676)" }} />
            </div>
          </div>
        )}

        {errMsg && <div style={{ marginTop: 12, color: "#ff8a80", fontSize: 13 }}>{errMsg}</div>}
      </section>

      {/* CARTE DU PARI LIVE IMMÉDIAT AVANT LA FIN DU MATCH */}
      {videoInsight && (
        <section className="fai-card" style={{ borderColor: "rgba(0, 230, 118, 0.5)" }}>
          {liveRec && (
            <div
              style={{
                background: "linear-gradient(135deg, rgba(0, 230, 118, 0.16), rgba(0, 229, 255, 0.1))",
                border: "1.5px solid #00e676",
                borderRadius: 14,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 900, color: "#00e676", letterSpacing: 0.6 }}>
                {liveRec.urgency} • PARI EN DIRECT À PRENDRE AVANT LA FIN DU MATCH
              </div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#fff", marginTop: 6 }}>
                🎯 {liveRec.marketLabel}
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 13 }}>
                <span style={{ color: "#00e676", fontWeight: 800 }}>
                  Probabilité IA Live : {liveRec.liveProbPct}%
                </span>
                <span style={{ color: "#00e5ff", fontWeight: 700 }}>
                  Cote juste IA : @{liveRec.fairLiveOdd.toFixed(2)}
                </span>
                <span style={{ color: "#fbbf24", fontWeight: 700 }}>
                  Ne jouer chez Betclic/1xBet qu&apos;à @{liveRec.minAcceptableBookOdd.toFixed(2)} ou plus
                </span>
              </div>
              <p style={{ fontSize: 12.5, color: "#cbd5e1", marginTop: 8, marginBottom: 12 }}>
                {liveRec.rationale}
              </p>
              {onAddLiveBetToCoupon && (
                <button
                  type="button"
                  className="fai-btn-primary"
                  style={{ maxWidth: 420 }}
                  onClick={() =>
                    onAddLiveBetToCoupon({
                      home: activeHome,
                      away: activeAway,
                      sport: rm?.sport || "soccer",
                      league: rm?.league || "ucl",
                      selectedMarket: {
                        code: liveRec.shortCode,
                        label: liveRec.marketLabel,
                        pct: liveRec.liveProbPct,
                        fairOdd: liveRec.fairLiveOdd,
                        minAcceptableOdd: liveRec.minAcceptableBookOdd,
                      },
                    })
                  }
                >
                  ⚡ Pari Live estimé — cote réelle requise avant ajout ({liveRec.liveProbPct}%)
                </button>
              )}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div style={{ background: "rgba(0, 229, 255, 0.08)", borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11.5, color: "#94a3b8" }}>Pressing Live</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#00e5ff" }}>
                {videoInsight.pressingScore} / 100
              </div>
            </div>
            <div style={{ background: "rgba(0, 230, 118, 0.08)", borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11.5, color: "#94a3b8" }}>Domination en cours</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#00e676" }}>
                {videoInsight.territorialTiltHome}% / {100 - videoInsight.territorialTiltHome}%
              </div>
            </div>
            <div style={{ background: "rgba(167, 139, 250, 0.09)", borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11.5, color: "#94a3b8" }}>Modif. xG Dom / Ext</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#c4b5fd" }}>
                ×{videoInsight.homeXgMult} / ×{videoInsight.awayXgMult}
              </div>
            </div>
          </div>

          <p style={{ fontSize: 13, color: "#e2e8f0", marginBottom: 12 }}>
            {videoInsight.tacticalVerdict}
          </p>

          <button
            type="button"
            className="fai-btn-chip"
            style={{ borderColor: "#00e5ff", color: "#00e5ff", fontWeight: 700 }}
            onClick={onApplyAndGoPredict}
          >
            🔮 Injecter aussi dans le Prédicteur Complet ({activeHome} vs {activeAway})
          </button>
        </section>
      )}
    </div>
  );
}
