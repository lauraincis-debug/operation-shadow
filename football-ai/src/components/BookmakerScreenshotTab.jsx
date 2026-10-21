import { useCallback, useEffect, useState } from "react";
import { CLUBS_DB } from "../data/clubs.js";
import { doesVideoInsightMatchTeams } from "../engine/videoAnalyzer.js";
import {
  extractScreenshotDataFromImage,
  evaluateScreenshotMarketsAndPickDefinitiveBet,
  parseBookmakerMarketsFromText,
} from "../engine/bookmakerScreenshotAnalyzer.js";

const DEMO_BETCLIC_SCREENSHOT_TEXT = `Betclic — Ligue des Champions
Paris SG - FC Barcelone
Résultat du match
Paris SG 2,05   Nul 3,75   FC Barcelone 3,30
Double chance
1N 1,32   12 1,28   N2 1,72
Total de buts
Plus de 1,5 1,19   Moins de 1,5 4,20
Plus de 2,5 1,62   Moins de 2,5 2,18
Les 2 équipes marquent
Oui 1,54   Non 2,32
Corners : Plus de 9,5 corners 1,68`;

export default function BookmakerScreenshotTab({
  liveMatches = [],
  modelState,
  videoInsight = null,
  currency = "XOF",
  bankrollCapital = 50000,
  onAddDefinitiveBetToCoupon,
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const [bookmakerName, setBookmakerName] = useState("Betclic");
  const [home, setHome] = useState("PSG");
  const [away, setAway] = useState("Barcelone");
  const [sport, setSport] = useState("soccer");
  const [league, setLeague] = useState("ucl");
  const [engineUsed, setEngineUsed] = useState("");
  const [extractedOptions, setExtractedOptions] = useState([]);
  const [teamsNeedConfirmation, setTeamsNeedConfirmation] = useState(false);

  // Ajout manuel ultra-rapide d'une option supplémentaire lue sur la capture si souhaité
  const [newKind, setNewKind] = useState("OVER");
  const [newLine, setNewLine] = useState("2.5");
  const [newOdd, setNewOdd] = useState("1.75");
  const [personalGeminiKey, setPersonalGeminiKey] = useState(() => {
    try {
      return localStorage.getItem("fai_user_gemini_vision_key") || "";
    } catch {
      return "";
    }
  });

  const processScreenshotFile = useCallback(
    async (file) => {
      if (!file || !file.type?.startsWith("image/")) {
        setErrMsg("Veuillez sélectionner ou coller une image (PNG, JPG, WEBP) de votre bookmaker.");
        return;
      }
      setErrMsg("");
      setBusy(true);
      setProgress(10);

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);

      try {
        const res = await extractScreenshotDataFromImage(
          file,
          liveMatches,
          (pct, msg) => {
            setProgress(pct);
            if (msg) setStatusMsg(msg);
          },
          { geminiKey: personalGeminiKey.trim() }
        );

        setEngineUsed(res.engineUsed);
        setBookmakerName(res.bookmakerName || "Betclic");
        if (res.detectedMatch && !res.teamsUnconfirmed) {
          setTeamsNeedConfirmation(false);
          setHome(res.detectedMatch.home);
          setAway(res.detectedMatch.away);
          setSport(res.detectedMatch.sport || "soccer");
          setLeague(res.detectedMatch.league || "ucl");
        } else {
          // Sécurité Anti-Erreur [AUDIT3-P1-01] : ne JAMAIS calculer sur PSG vs Barcelone par défaut sans confirmation explicite !
          setTeamsNeedConfirmation(true);
          setErrMsg(
            "🛡️ Sécurité Anti-Erreur : les cotes ont été lues, mais les noms des 2 équipes ne sont pas lisibles avec certitude sur cette capture. Sélectionnez les 2 équipes exactes ci-dessous puis cliquez sur « ✅ Confirmer ces 2 équipes » pour calculer le vrai Pari Définitif."
          );
        }

        if (res.options.length === 0) {
          setErrMsg(
            "L'image a été chargée mais peu de cotes numériques ont été détectées automatiquement : vérifiez les équipes ci-dessous ou ajoutez la cote visible en 1 clic."
          );
        } else {
          setExtractedOptions(res.options);
        }
      } catch (e) {
        setErrMsg(e.message || "Erreur lors de l'analyse optique de la capture.");
      }
      setBusy(false);
    },
    [liveMatches, previewUrl, personalGeminiKey]
  );

  // Support du collage direct Ctrl+V / Cmd+V d'une capture d'écran !
  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.type?.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) processScreenshotFile(f);
          break;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [processScreenshotFile]);

  const handleLoadBetclicDemo = () => {
    setErrMsg("");
    setTeamsNeedConfirmation(false);
    setBookmakerName("Betclic");
    setHome("PSG");
    setAway("Barcelone");
    setSport("soccer");
    setLeague("ucl");
    setEngineUsed("Simulation Capture Officielle Betclic (11 options extraites)");
    const parsed = parseBookmakerMarketsFromText(
      DEMO_BETCLIC_SCREENSHOT_TEXT,
      "PSG",
      "Barcelone"
    );
    setExtractedOptions(parsed);
  };

  const matchedVideoBoost = doesVideoInsightMatchTeams(videoInsight, home, away)
    ? videoInsight
    : null;

  const verdict =
    extractedOptions.length > 0 && !teamsNeedConfirmation
      ? evaluateScreenshotMarketsAndPickDefinitiveBet({
          home,
          away,
          sport,
          league,
          bookmakerName,
          extractedOptions,
          modelState,
          liveMatch:
            liveMatches.find((m) => m.home === home && m.away === away) || null,
          videoInsight: matchedVideoBoost,
          bankrollCapital,
          currency,
        })
      : null;

  const fmtStake = (amt) =>
    currency === "EUR"
      ? `${Number(amt).toFixed(2)} €`
      : `${Math.round(Number(amt)).toLocaleString("fr-FR")} FCFA`;

  const handleUpdateOptionOdd = (idx, nextOddStr) => {
    const val = parseFloat(String(nextOddStr).replace(",", "."));
    setExtractedOptions((prev) =>
      prev.map((o, i) =>
        i === idx && Number.isFinite(val) && val > 1.01 ? { ...o, bookOdd: val } : o
      )
    );
  };

  const handleAddManualOption = () => {
    const odd = parseFloat(String(newOdd).replace(",", "."));
    const lineNum = ["OVER", "UNDER", "CORNERS_OVER", "HT_OVER"].includes(newKind)
      ? parseFloat(newLine)
      : null;
    if (!Number.isFinite(odd) || odd <= 1.01) return;

    const labelsMap = {
      "1": `Victoire ${home} (1)`,
      N: "Match Nul (N)",
      "2": `Victoire ${away} (2)`,
      "1X": `Double Chance ${home} ou Nul (1N)`,
      X2: `Double Chance Nul ou ${away} (N2)`,
      "12": `Double Chance ${home} ou ${away} (12)`,
      BTTS_Y: "Les 2 équipes marquent : Oui",
      BTTS_N: "Les 2 équipes marquent : Non",
      OVER: `Plus de ${lineNum} Buts/Points`,
      UNDER: `Moins de ${lineNum} Buts/Points`,
      CORNERS_OVER: `Plus de ${lineNum} Corners`,
      HT_OVER: `Plus de ${lineNum} But MT`,
    };
    setExtractedOptions((prev) => [
      ...prev,
      {
        kind: newKind,
        line: lineNum,
        label: labelsMap[newKind] || newKind,
        bookOdd: odd,
      },
    ]);
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section className="fai-card">
        <div className="fai-card-title">
          📸 SCANNER DE CAPTURE BOOKMAKER (BETCLIC • 1XBET • WINAMAX • SPORTCASH) ➔ PARI DÉFINITIF
        </div>
        <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 14, lineHeight: 1.55 }}>
          Importez, photographiez ou collez directement (<strong>Ctrl+V</strong>) une capture d&apos;écran de{" "}
          <strong>Betclic</strong> (ou tout autre bookmaker). L&apos;IA lit toutes les options et cotes affichées,
          calcule la vraie probabilité mathématique et l&apos;espérance de gain (EV%) de chacune, élimine les
          pièges à marge élevée, et vous sort <strong>UN SEUL PARI DÉFINITIF</strong>.
        </p>

        {/* ZONE D'ENVOI / DRAG & DROP / PHOTO / CTRL+V */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer?.files?.[0];
            if (f) processScreenshotFile(f);
          }}
          style={{
            border: "2px dashed rgba(0, 229, 255, 0.45)",
            borderRadius: 14,
            padding: 20,
            textAlign: "center",
            background: "rgba(0, 229, 255, 0.04)",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <label
              className="fai-btn-primary"
              style={{ width: "auto", padding: "12px 22px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              📲 Envoyer une Capture Betclic / Bookmaker (Image ou Photo)
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) processScreenshotFile(f);
                  e.target.value = "";
                }}
                disabled={busy}
              />
            </label>

            <button
              type="button"
              className="fai-btn-chip"
              style={{ borderColor: "#fbbf24", color: "#fbbf24", fontWeight: 700, padding: "10px 16px" }}
              onClick={handleLoadBetclicDemo}
              disabled={busy}
            >
              ⚡ Tester un Exemple Réel de Capture Betclic (11 cotes)
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 8 }}>
            🔓 <strong>100 % gratuit &amp; illimité sans clé API</strong> (moteur OCR WASM FRA+ENG intégré sur téléphone &amp; PC — sur ordinateur, faites aussi <strong>Ctrl+V</strong> directement).
          </div>
          <details style={{ marginTop: 8, textAlign: "left", maxWidth: 520, marginInline: "auto" }}>
            <summary style={{ cursor: "pointer", fontSize: 11.5, color: "#38bdf8", textAlign: "center" }}>
              ⚡ Optionnel : activer aussi Gemini Vision IA (clé AI Studio personnelle gratuite)
            </summary>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input
                type="password"
                className="fai-select"
                placeholder="Coller votre clé AIza... (optionnel — conservée uniquement sur votre appareil)"
                value={personalGeminiKey}
                onChange={(e) => {
                  const val = e.target.value;
                  setPersonalGeminiKey(val);
                  try {
                    localStorage.setItem("fai_user_gemini_vision_key", val);
                  } catch {
                    // ignore
                  }
                }}
              />
            </div>
          </details>
        </div>

        {busy && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, color: "#00e5ff", marginBottom: 5 }}>
              {statusMsg || "Analyse de la capture Betclic..."} ({progress}%)
            </div>
            <div style={{ height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "linear-gradient(90deg, #00e5ff, #00e676)" }} />
            </div>
          </div>
        )}

        {errMsg && (
          <div
            style={{
              marginBottom: 14,
              padding: "10px 14px",
              borderRadius: 10,
              background: teamsNeedConfirmation ? "rgba(245, 158, 11, 0.14)" : "rgba(255, 82, 82, 0.12)",
              border: `1px solid ${teamsNeedConfirmation ? "rgba(245, 158, 11, 0.5)" : "rgba(255, 82, 82, 0.4)"}`,
              color: teamsNeedConfirmation ? "#fde68a" : "#ff8a80",
              fontSize: 12.5,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <span>{errMsg}</span>
            {teamsNeedConfirmation && (
              <button
                type="button"
                onClick={() => {
                  setTeamsNeedConfirmation(false);
                  setErrMsg("");
                }}
                style={{
                  background: "linear-gradient(135deg, #10b981, #059669)",
                  border: "none",
                  borderRadius: 8,
                  padding: "7px 13px",
                  color: "#fff",
                  fontWeight: 800,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                ✅ Confirmer {home} vs {away} &amp; Calculer le Pari Définitif
              </button>
            )}
          </div>
        )}

        {/* CONTRÔLE DES ÉQUIPES RECONNUES + APERÇU CAPTURE */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: previewUrl ? "minmax(200px, 260px) 1fr" : "1fr",
            gap: 16,
            alignItems: "start",
          }}
        >
          {previewUrl && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Capture importée :</div>
              <img
                src={previewUrl}
                alt="Capture Bookmaker"
                style={{
                  width: "100%",
                  maxHeight: 280,
                  objectFit: "contain",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "#020617",
                }}
              />
            </div>
          )}

          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 10,
              }}
            >
              <div>
                <label style={{ fontSize: 11, color: "#94a3b8" }}>Bookmaker</label>
                <input
                  className="fai-select"
                  value={bookmakerName}
                  onChange={(e) => setBookmakerName(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "#94a3b8" }}>Équipe Domicile</label>
                <input
                  className="fai-select"
                  list="clubs-dl-bmp"
                  value={home}
                  onChange={(e) => setHome(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "#94a3b8" }}>Équipe Extérieur</label>
                <input
                  className="fai-select"
                  list="clubs-dl-bmp"
                  value={away}
                  onChange={(e) => setAway(e.target.value)}
                />
              </div>
            </div>

            <datalist id="clubs-dl-bmp">
              {CLUBS_DB.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>

            {/* AJOUT RAPIDE D'UNE OPTION SUPPLÉMENTAIRE */}
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
                background: "rgba(15, 23, 42, 0.65)",
                padding: 10,
                borderRadius: 10,
              }}
            >
              <span style={{ fontSize: 12, color: "#cbd5e1", fontWeight: 700 }}>
                ➕ Ajouter/ajuster une cote {bookmakerName} :
              </span>
              <select
                className="fai-select"
                style={{ width: "auto", minWidth: 165 }}
                value={newKind}
                onChange={(e) => setNewKind(e.target.value)}
              >
                <option value="1">Victoire Domicile (1)</option>
                <option value="N">Match Nul (N)</option>
                <option value="2">Victoire Extérieur (2)</option>
                <option value="1X">Double Chance 1N</option>
                <option value="X2">Double Chance N2</option>
                <option value="12">Double Chance 12</option>
                <option value="OVER">Plus de X,5 Buts/Pts</option>
                <option value="UNDER">Moins de X,5 Buts/Pts</option>
                <option value="BTTS_Y">Les 2 marquent : Oui</option>
                <option value="BTTS_N">Les 2 marquent : Non</option>
                <option value="CORNERS_OVER">Plus de X,5 Corners</option>
                <option value="HT_OVER">Plus de 0,5 But MT</option>
              </select>

              {["OVER", "UNDER", "CORNERS_OVER", "HT_OVER"].includes(newKind) && (
                <input
                  className="fai-select"
                  style={{ width: 82 }}
                  type="number"
                  step="0.5"
                  value={newLine}
                  onChange={(e) => setNewLine(e.target.value)}
                  placeholder="Palier"
                />
              )}

              <input
                className="fai-select"
                style={{ width: 92 }}
                type="number"
                step="0.01"
                min="1.03"
                value={newOdd}
                onChange={(e) => setNewOdd(e.target.value)}
                placeholder="Cote"
              />

              <button type="button" className="fai-btn-chip" onClick={handleAddManualOption}>
                + Ajouter à l&apos;analyse
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* RÉSULTAT PRINCIPAL : LE PARI DÉFINITIF UNIQUE */}
      {verdict && (
        <section
          className="fai-card"
          style={{
            borderColor: verdict.hasApprovedBet ? "#00e676" : "#ff5252",
            borderWidth: 2,
          }}
        >
          {engineUsed && (
            <div style={{ fontSize: 11.5, color: "#38bdf8", marginBottom: 8 }}>
              🤖 Moteur utilisé : <strong>{engineUsed}</strong> • {verdict.expectedSummary}
            </div>
          )}

          {/* CARTE DU VERDICT DÉFINITIF UNIQUE */}
          <div
            style={{
              background: verdict.hasApprovedBet
                ? "linear-gradient(135deg, rgba(0, 230, 118, 0.17), rgba(251, 191, 36, 0.1))"
                : "rgba(255, 82, 82, 0.12)",
              border: `2px solid ${verdict.hasApprovedBet ? "#00e676" : "#ff5252"}`,
              borderRadius: 16,
              padding: 18,
              marginBottom: 18,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 900,
                letterSpacing: 0.7,
                color: verdict.hasApprovedBet ? "#fbbf24" : "#ff8a80",
              }}
            >
              DÉCISION FINALE UNIQUE APRÈS TRI DE TOUTES LES OPTIONS {bookmakerName.toUpperCase()}
            </div>

            <div style={{ fontSize: 21, fontWeight: 900, color: "#fff", marginTop: 6 }}>
              {verdict.verdictHeadline}
            </div>

            <p style={{ fontSize: 13.5, color: "#e2e8f0", marginTop: 8, lineHeight: 1.55 }}>
              {verdict.verdictExplanation}
            </p>

            {verdict.definitiveBet && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: 10,
                  marginTop: 12,
                  marginBottom: 14,
                }}
              >
                <div style={{ background: "rgba(15,23,42,0.78)", padding: 10, borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>Cote {bookmakerName}</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#fbbf24" }}>
                    @{verdict.definitiveBet.bookOdd.toFixed(2)}
                  </div>
                </div>
                <div style={{ background: "rgba(15,23,42,0.78)", padding: 10, borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>Vraie Probabilité IA</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#00e676" }}>
                    {verdict.definitiveBet.trueProbPct}%
                  </div>
                </div>
                <div style={{ background: "rgba(15,23,42,0.78)", padding: 10, borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>Avantage Value (EV)</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#00e5ff" }}>
                    {verdict.definitiveBet.evPct >= 0 ? "+" : ""}
                    {verdict.definitiveBet.evPct}%
                  </div>
                </div>
                <div style={{ background: "rgba(15,23,42,0.78)", padding: 10, borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>Mise Kelly Conseillée</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#fff" }}>
                    {fmtStake(verdict.definitiveBet.recommendedStake)}
                  </div>
                </div>
              </div>
            )}

            {verdict.definitiveBet && onAddDefinitiveBetToCoupon && (
              <button
                type="button"
                className="fai-btn-primary"
                style={{ maxWidth: 460 }}
                onClick={() =>
                  onAddDefinitiveBetToCoupon({
                    home,
                    away,
                    sport,
                    league,
                    selectedMarket: {
                      code: verdict.definitiveBet.kind,
                      label: `${verdict.definitiveBet.label} [${bookmakerName}]`,
                      pct: Math.round(verdict.definitiveBet.trueProbPct),
                      fairOdd: verdict.definitiveBet.fairOdd,
                      bookOdd: verdict.definitiveBet.bookOdd,
                    },
                  })
                }
              >
                🏆 Valider &amp; Envoyer ce Pari Définitif au Coupon (@{verdict.definitiveBet.bookOdd.toFixed(2)})
              </button>
            )}
          </div>

          {/* TABLEAU COMPARATIF COMPLET DE TOUTES LES OPTIONS LUES SUR LA CAPTURE */}
          <div className="fai-card-title" style={{ fontSize: 14 }}>
            📊 Classement Mathématique Complet des {verdict.analyzedOptions.length} Options lues sur {bookmakerName}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {verdict.analyzedOptions.map((opt, rankIdx) => {
              const rawIdx = extractedOptions.findIndex(
                (r) => r.kind === opt.kind && r.line === opt.line
              );
              const isWinner = verdict.definitiveBet?.id === opt.id;
              return (
                <div
                  key={opt.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: isWinner ? "rgba(0, 230, 118, 0.12)" : "rgba(15, 23, 42, 0.65)",
                    border: `1px solid ${
                      isWinner ? "#00e676" : "rgba(255, 255, 255, 0.08)"
                    }`,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, color: "#fff", fontSize: 13.5 }}>
                      #{rankIdx + 1} {isWinner ? "🏆 " : ""}
                      {opt.label}{" "}
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: "rgba(255,255,255,0.08)",
                          color: opt.evPct >= 0 ? "#00e676" : "#fca5a5",
                          marginLeft: 6,
                        }}
                      >
                        {opt.statusTag}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 3 }}>
                      Prob. réelle IA : <strong style={{ color: "#e2e8f0" }}>{opt.trueProbPct}%</strong> •
                      Implicite {bookmakerName} : {opt.impliedProbPct}% • Cote juste IA : @{opt.fairOdd.toFixed(2)} •
                      EV :{" "}
                      <strong style={{ color: opt.evPct >= 0 ? "#00e676" : "#ff8a80" }}>
                        {opt.evPct >= 0 ? "+" : ""}
                        {opt.evPct}%
                      </strong>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: "#94a3b8" }}>Cote :</span>
                    <input
                      type="number"
                      step="0.01"
                      min="1.02"
                      value={opt.bookOdd}
                      onChange={(e) => handleUpdateOptionOdd(rawIdx, e.target.value)}
                      style={{
                        width: 74,
                        padding: "5px 8px",
                        borderRadius: 8,
                        background: "#020617",
                        color: "#fbbf24",
                        fontWeight: 800,
                        border: "1px solid rgba(251,191,36,0.4)",
                      }}
                    />
                    <button
                      type="button"
                      className="fai-btn-chip"
                      style={{ padding: "4px 8px", fontSize: 11 }}
                      onClick={() =>
                        setExtractedOptions((prev) => prev.filter((_, i) => i !== rawIdx))
                      }
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
