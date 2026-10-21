import { useState, useRef, useEffect, useCallback } from "react";
import {
  analyzeMatchVideoFile,
  fetchVerifiedMatchVideosFromInternet,
  analyzeOfficialInternetMatchClip,
} from "../engine/videoAnalyzer.js";

export default function VideoAnalysisTab({
  activeHome,
  activeAway,
  liveMatches = [],
  videoInsight,
  onVideoInsightReady,
  onClearVideoInsight,
  onSelectTargetMatch,
  onApplyAndGoPredict,
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [scanResult, setScanResult] = useState(null);
  const [scanningNet, setScanningNet] = useState(false);
  const videoPlayerRef = useRef(null);
  const uploadInputRef = useRef(null);

  const runAutoInternetVideoDiscovery = useCallback(async (overrideMatch = null) => {
    setScanningNet(true);
    setErrorMsg("");
    try {
      const target = overrideMatch || { home: activeHome, away: activeAway };
      const res = await fetchVerifiedMatchVideosFromInternet(target, liveMatches);
      setScanResult(res);

      // Si au moins une vidéo officielle certifiée (bon match + bonne date exacte) est trouvée,
      // lancer automatiquement son analyse tactique !
      if (res.verifiedClips.length > 0) {
        setAnalyzing(true);
        setProgress(25);
        const autoInsight = await analyzeOfficialInternetMatchClip(
          res.verifiedClips[0],
          res.resolvedMatch,
          res.espnSummaryJson,
          (pct) => setProgress(pct)
        );
        onVideoInsightReady(autoInsight);
        setAnalyzing(false);
      }
    } catch (err) {
      setErrorMsg(err.message || "Erreur lors de la recherche vidéo Internet.");
      setAnalyzing(false);
    }
    setScanningNet(false);
  }, [activeHome, activeAway, liveMatches, onVideoInsightReady]);

  // Recherche automatique dès l'ouverture de l'onglet ou changement d'affiche !
  useEffect(() => {
    runAutoInternetVideoDiscovery();
  }, [activeHome, activeAway]);

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalyzing(true);
    setProgress(5);
    setErrorMsg("");

    try {
      const result = await analyzeMatchVideoFile(file, (pct) => setProgress(pct));
      onVideoInsightReady(result);
    } catch (err) {
      setErrorMsg(err.message || "Vidéo rejetée par le filtre de sécurité.");
    }
    setAnalyzing(false);
    e.target.value = "";
  };

  const handlePickCatalogClip = async (clip) => {
    if (onSelectTargetMatch) {
      onSelectTargetMatch(clip.homeTeam, clip.awayTeam);
    }
    setAnalyzing(true);
    setErrorMsg("");
    try {
      const fakeResolved = {
        home: clip.homeTeam,
        away: clip.awayTeam,
        kickoffIso: clip.dateIso,
      };
      const verifiedClip = {
        ...clip,
        verification: {
          verified: true,
          videoDateFr: new Date(clip.dateIso).toLocaleString("fr-FR"),
        },
      };
      const insight = await analyzeOfficialInternetMatchClip(
        verifiedClip,
        fakeResolved,
        null,
        (pct) => setProgress(pct)
      );
      onVideoInsightReady(insight);
    } catch (err) {
      setErrorMsg(err.message);
    }
    setAnalyzing(false);
  };

  // Matchs actuellement EN DIRECT 🔴 ou TERMINÉS 🏁 dans le calendrier live
  const startedOrFinishedLive = (liveMatches || []).filter(
    (m) => m.state === "in" || m.completed
  );

  return (
    <div>
      {/* 1. COLLECTEUR AUTOMATIQUE DE VIDÉOS INTERNET VÉRIFIÉES (BON MATCH + DATE EXACTE) */}
      <div className="fai-panel" style={{ borderColor: "rgba(0, 229, 255, 0.4)" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div>
            <div className="fai-section-title" style={{ marginBottom: 4 }}>
              <span>
                🎥 Récupération Automatique sur Internet &amp; Vérification Stricte (Match + Date Exacte)
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: "#9aa3c7" }}>
              Rencontre ciblée :{" "}
              <strong style={{ color: "#00e676" }}>
                {activeHome} vs {activeAway}
              </strong>{" "}
              • Quadruple contrôle actif :{" "}
              <span style={{ color: "#00e5ff" }}>
                Identité des 2 équipes + Date officielle (±36h max) + Coup d&apos;envoi réel + Surface terrain
              </span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="fai-btn-secondary"
              disabled={scanningNet}
              onClick={() => runAutoInternetVideoDiscovery()}
            >
              {scanningNet
                ? "⏳ Recherche Internet en cours..."
                : "🌐 Rechercher les Vidéos Officielles de ce Match"}
            </button>
            {videoInsight && (
              <button
                type="button"
                className="fai-btn-ghost"
                style={{ color: "#ff5252" }}
                onClick={onClearVideoInsight}
              >
                ✕ Retirer l&apos;impact vidéo
              </button>
            )}
          </div>
        </div>

        {/* Journal de vérification anti-erreur de match / anti-mauvaise date */}
        {scanResult?.auditLog?.length > 0 && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(255, 234, 0, 0.08)",
              border: "1px solid rgba(255, 234, 0, 0.35)",
              fontSize: 12,
              color: "#ffea00",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            {scanResult.auditLog.map((msg, i) => (
              <div key={i}>🛡️ {msg}</div>
            ))}
          </div>
        )}

        {/* Clips officiels certifiés trouvés pour CE match précis et CETTE date précise */}
        {scanResult?.verifiedClips?.length > 0 ? (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#00e676", marginBottom: 8 }}>
              ✅ {scanResult.verifiedClips.length} Séquence(s) Vidéo Officielle(s) Certifiée(s) pour {activeHome} vs {activeAway} :
            </div>
            <div className="fai-grid-2">
              {scanResult.verifiedClips.map((clip) => (
                <div
                  key={clip.id}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    background: "rgba(0, 230, 118, 0.07)",
                    border: "1px solid rgba(0, 230, 118, 0.4)",
                  }}
                >
                  <div style={{ fontSize: 11, color: "#00e676", fontWeight: 800 }}>
                    ✅ BON MATCH &amp; BONNE DATE : {clip.verification.videoDateFr} • {clip.provider}
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: "#fff", margin: "4px 0" }}>
                    🎬 {clip.title}
                  </div>
                  <button
                    type="button"
                    className="fai-btn-secondary"
                    style={{ marginTop: 6, fontSize: 11.5 }}
                    onClick={async () => {
                      setAnalyzing(true);
                      const ins = await analyzeOfficialInternetMatchClip(
                        clip,
                        scanResult.resolvedMatch,
                        scanResult.espnSummaryJson,
                        (p) => setProgress(p)
                      );
                      onVideoInsightReady(ins);
                      setAnalyzing(false);
                    }}
                  >
                    ⚡ Analyser cette séquence certifiée
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : !scanningNet ? (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
              fontSize: 12,
              color: "#b6c0e8",
              marginBottom: 14,
            }}
          >
            ℹ️ Aucune séquence vidéo en cours/récente publiée pour{" "}
            <strong>
              {activeHome} vs {activeAway}
            </strong>{" "}
            à cette heure précise. Sélectionnez ci-dessous en <strong>1 clic</strong> l&apos;une des{" "}
            <strong>vraies rencontres filmées en direct / récentes sur Internet</strong> (avec date exacte vérifiée) ou importez votre extrait <code>.mp4</code> !
          </div>
        ) : null}

        {/* Sélection directe en 1 clic des vrais matchs EN COURS 🔴 ou avec vidéos officielles sur Internet */}
        {scanResult?.availableLiveVideoCatalog?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "#00e5ff", marginBottom: 8 }}>
              📡 VIDÉOS OFFICIELLES RÉCENTES VÉRIFIÉES SUR INTERNET (CLIQUEZ POUR CHARGER &amp; ANALYSER LE BON MATCH) :
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
              {scanResult.availableLiveVideoCatalog.slice(0, 10).map((clip) => (
                <button
                  key={clip.id}
                  type="button"
                  className="fai-quick-chip"
                  onClick={() => handlePickCatalogClip(clip)}
                >
                  🎬 {clip.homeTeam} vs {clip.awayTeam} ({new Date(clip.dateIso).toLocaleDateString("fr-FR")})
                </button>
              ))}
            </div>
          </div>
        )}

        {startedOrFinishedLive.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "#ff80ab", marginBottom: 6 }}>
              🔴 RENCONTRES ACTUELLEMENT EN COURS OU TERMINÉES AUJOURD&apos;HUI ({startedOrFinishedLive.length}) :
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
              {startedOrFinishedLive.slice(0, 10).map((m) => (
                <button
                  key={m.externalId}
                  type="button"
                  className="fai-quick-chip"
                  onClick={() => {
                    if (onSelectTargetMatch) onSelectTargetMatch(m.home, m.away);
                    runAutoInternetVideoDiscovery(m);
                  }}
                >
                  {m.state === "in" ? "🔴" : "🏁"} {m.home} {m.scoreHome ?? 0}-{m.scoreAway ?? 0} {m.away} ({m.dateFr})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Import local sécurisé (avec filtre strict anti-vidéo non sportive >= 14% terrain !) */}
        <div
          onClick={() => uploadInputRef.current?.click()}
          style={{
            border: "1.5px dashed rgba(0, 229, 255, 0.35)",
            borderRadius: 14,
            padding: "16px",
            textAlign: "center",
            background: "rgba(8, 10, 28, 0.65)",
            cursor: "pointer",
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#fff" }}>
            📹 Ou importer un fichier vidéo filmé du match (MP4 / WebM / MOV — vérification anti-hors-sujet active)
          </div>
          <div style={{ fontSize: 11.5, color: "#7f89b2", marginTop: 3 }}>
            Toute vidéo ne montrant pas une vraie surface de terrain sportif (&lt; 14%) est automatiquement bloquée et rejetée.
          </div>
          <input
            ref={uploadInputRef}
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
        </div>

        {analyzing && (
          <div style={{ marginTop: 14, color: "#00e5ff", fontSize: 12.5, fontWeight: 700 }}>
            🔍 Vérification identité + date et extraction tactique en cours ({progress}%)...
          </div>
        )}

        {errorMsg && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              background: "rgba(255, 23, 68, 0.14)",
              border: "1px solid #ff1744",
              color: "#ff8a80",
              fontSize: 12.5,
              fontWeight: 700,
            }}
          >
            {errorMsg}
          </div>
        )}
      </div>

      {/* 2. LECTEUR VIDÉO OFFICIEL INTÉGRÉ + RÉSULTATS TACTIQUES */}
      {videoInsight && (
        <div className="fai-panel">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#00e676" }}>
                {videoInsight.isVerifiedInternetVideo
                  ? `✅ SÉQUENCE INTERNET CERTIFIÉE • ${videoInsight.verifiedDateFr}`
                  : "✅ SÉQUENCE SPORTIVE LOCALE VALIDÉE PAR VISION IA"}
              </div>
              <div style={{ fontSize: 16, fontWeight: 900, color: "#fff", marginTop: 2 }}>
                {videoInsight.fileName}
              </div>
            </div>

            {onApplyAndGoPredict && (
              <button
                type="button"
                className="fai-btn-primary"
                onClick={onApplyAndGoPredict}
              >
                🎯 Appliquer au Prédicteur ({videoInsight.homeXgMult}× / {videoInsight.awayXgMult}× xG)
              </button>
            )}
          </div>

          {/* Lecteur vidéo direct (MP4 officiel ou Embed sécurisé sandboxé ScoreBat) */}
          {(videoInsight.mp4Url || videoInsight.objectUrl) && (
            <video
              ref={videoPlayerRef}
              src={videoInsight.mp4Url || videoInsight.objectUrl}
              poster={videoInsight.thumbnail || undefined}
              controls
              playsInline
              style={{
                width: "100%",
                maxHeight: 360,
                borderRadius: 12,
                background: "#000",
                marginBottom: 14,
              }}
            />
          )}

          {videoInsight.embedSrc && !videoInsight.mp4Url && (
            <div style={{ marginBottom: 14, borderRadius: 12, overflow: "hidden" }}>
              <iframe
                src={videoInsight.embedSrc}
                title={videoInsight.fileName}
                sandbox="allow-scripts allow-same-origin allow-presentation"
                referrerPolicy="no-referrer"
                allowFullScreen
                style={{ width: "100%", height: 340, border: 0, background: "#000" }}
              />
            </div>
          )}

          <div className="fai-grid-3" style={{ marginBottom: 14 }}>
            <div style={{ padding: 12, borderRadius: 10, background: "#090c22" }}>
              <div style={{ fontSize: 11, color: "#8e98c2" }}>INTENSITÉ PRESSING</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#00e5ff" }}>
                {videoInsight.pressingScore}/100
              </div>
            </div>
            <div style={{ padding: 12, borderRadius: 10, background: "#090c22" }}>
              <div style={{ fontSize: 11, color: "#8e98c2" }}>DOMINATION TERRITORIALE</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#00e676" }}>
                {videoInsight.territorialTiltHome}% / {100 - videoInsight.territorialTiltHome}%
              </div>
            </div>
            <div style={{ padding: 12, borderRadius: 10, background: "#090c22" }}>
              <div style={{ fontSize: 11, color: "#8e98c2" }}>MODIFICATEURS xG CALIBRÉS</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#ffea00" }}>
                Dom ×{videoInsight.homeXgMult} • Ext ×{videoInsight.awayXgMult}
              </div>
            </div>
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: "rgba(0, 230, 118, 0.08)",
              border: "1px solid rgba(0, 230, 118, 0.3)",
              fontSize: 13,
              color: "#e2e8f0",
            }}
          >
            🧠 <strong> Synthèse tactique vérifiée :</strong> {videoInsight.tacticalVerdict}
          </div>
        </div>
      )}
    </div>
  );
}
