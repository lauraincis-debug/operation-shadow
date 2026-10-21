import { useState, useEffect, useMemo, useRef } from "react";
import { createCloeFootballBrain } from "../services/cloeBridge.js";
import { generateThreeDailyTickets } from "../engine/ticketGenerator.js";
import { auditCouponSlip } from "../engine/ticketAuditor.js";
import { rebuildModelState } from "../engine/predictor.js";

const CLOE_MEM_KEY = "cloe_ultra_personal_memory_v4";

function loadCloeMemory() {
  try {
    const raw = localStorage.getItem(CLOE_MEM_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {
    userName: "Boss",
    iqScore: 128,
    notes: [
      { id: 1, text: "Vérifier le Ticket Sécurité IA avant les matchs de 20h45", done: false },
      { id: 2, text: "Valider le Capitaine ×2 Fantasy sous 100 M€", done: false },
    ],
    lessons: [
      "Toujours privilégier la sécurité Double Chance / +1.5 Buts quand l'écart Elo est inférieur à 55 pts.",
      "Adapter les montants en FCFA et appliquer le Critère de Kelly ¼ pour protéger le capital.",
    ],
    llmProvider: "gemini", // gemini | groq | openai
    llmApiKey: "",
    favoriteClubs: ["PSG", "Real Madrid", "Arsenal", "Côte d'Ivoire"],
  };
}

export default function CloeApp() {
  const [mem, setMem] = useState(loadCloeMemory);
  const [section, setSection] = useState("assistant"); // assistant | briefing | memory | settings
  const [voiceOn, setVoiceOn] = useState(true);
  const [handsFreeCall, setHandsFreeCall] = useState(false);
  const handsFreeRef = useRef(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncedWallet, setSyncedWallet] = useState(() => {
    try {
      const saved = localStorage.getItem("cloe_synced_wallet_v5");
      return saved ? JSON.parse(saved) : { capital: 50000, stake: 1000, currency: "XOF", coupon: [] };
    } catch {
      return { capital: 50000, stake: 1000, currency: "XOF", coupon: [] };
    }
  });
  const [input, setInput] = useState("");
  const [newNote, setNewNote] = useState("");
  const [correctionText, setCorrectionText] = useState("");
  const [correctingIdx, setCorrectingIdx] = useState(null);
  const [dailyBriefing, setDailyBriefing] = useState(null);

  const [messages, setMessages] = useState([
    {
      role: "cloe",
      text: "Bonjour ! Je suis Cloé IA Ultra v6.3 Certifiée Intégrale, reliée en temps réel à ton moteur Omni-Sport & Football AI Ultra v6.3 Certifiée Intégrale (https://football-ai-43e33.web.app).\n\nTu peux m'envoyer une 📸 Capture Betclic / Winamax / 1xBet / Sportcash pour extraire 1 SEUL Pari Définitif optimal, lancer les 🔴 Vidéos & flux Live des matchs EN COURS uniquement pour parier en direct avant la fin du match, démarrer un 📞 Appel Vocal Mains-Libres, ou interroger les 🌐 7 Sports en direct !",
      rated: null,
    },
  ]);

  const footBrain = useMemo(() => createCloeFootballBrain(), []);

  const updateMem = (patch) => {
    setMem((prev) => {
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      try {
        localStorage.setItem(CLOE_MEM_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  useEffect(() => {
    footBrain
      .getDailyBriefing()
      .then((b) => setDailyBriefing(b))
      .catch(() => {});
  }, [footBrain]);

  useEffect(() => {
    handsFreeRef.current = handsFreeCall;
  }, [handsFreeCall]);

  // Réception instantanée SÉCURISÉE Bankroll + Ticket depuis Football AI (#sync=...)
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.location.hash.startsWith("#sync=")) {
        const b64 = window.location.hash.slice(6);
        window.history.replaceState(null, "", window.location.pathname);
        if (b64.length <= 24000) {
          const decoded = JSON.parse(decodeURIComponent(escape(atob(b64))));
          const safeStr = (v, n = 80) => String(v || "").replace(/[<>`]/g, "").slice(0, n);
          if (decoded && typeof decoded === "object") {
            const cleanWallet = {
              currency: safeStr(decoded.currency || "FCFA", 8),
              capital: Math.max(0, Number(decoded.capital) || 50000),
              stake: Math.max(0, Number(decoded.stake) || 1000),
              coupon: Array.isArray(decoded.coupon) ? decoded.coupon.slice(0, 12) : [],
            };
            setSyncedWallet(cleanWallet);
            localStorage.setItem("cloe_synced_wallet_v5", JSON.stringify(cleanWallet));
            if (cleanWallet.coupon.length > 0) {
              const audit = auditCouponSlip(cleanWallet.coupon, rebuildModelState([]));
              const warnStake =
                cleanWallet.stake > cleanWallet.capital * 0.05
                  ? `\n⚠️ Attention Bankroll : ta mise (${cleanWallet.stake} ${cleanWallet.currency}) dépasse 5% de ton capital (${cleanWallet.capital} ${cleanWallet.currency}) !`
                  : `\n✅ Ta mise respecte parfaitement la protection Kelly sur ton capital de ${cleanWallet.capital} ${cleanWallet.currency}.`;
              setMessages((prev) => [
                ...prev,
                {
                  role: "cloe",
                  text:
                    `🔗 Synchronisation sécurisée reçue depuis Omni-Sport AI Ultra v6.3 !\n` +
                    `• Capital suivi : ${cleanWallet.capital} ${cleanWallet.currency} | Ticket reçu : ${cleanWallet.coupon.length} match(s)\n` +
                    (audit
                      ? `• 📸 Audit Survie IA : ${audit.grade} (${audit.auditScore}/100) — Maillon faible : ${audit.weakestLink.matchLabel} (${audit.weakestLink.chosenPct}%)`
                      : "") +
                    warnStake,
                  rated: null,
                },
              ]);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const speak = (text) => {
    if (!voiceOn || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = "fr-FR";
      utt.rate = 1.03;
      const voices = window.speechSynthesis.getVoices?.() || [];
      const frFemale = voices.find(
        (v) => v.lang.startsWith("fr") && /amelie|hortense|julie|thomas|google/i.test(v.name)
      );
      if (frFemale) utt.voice = frFemale;
      utt.onstart = () => setSpeaking(true);
      utt.onend = () => {
        setSpeaking(false);
        // En mode Appel Vocal Mains-Libres, Cloé relance automatiquement l'écoute dès qu'elle finit de parler !
        if (handsFreeRef.current) {
          setTimeout(() => {
            if (handsFreeRef.current) startMic();
          }, 350);
        }
      };
      utt.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utt);
    } catch {
      setSpeaking(false);
    }
  };

  async function callOptionalCloudLlm(userPrompt, groundedContext) {
    if (!mem.llmApiKey?.trim()) return null;
    // P2 : Disjoncteur budgétaire journalier strict (max 60 requêtes Cloud/jour)
    try {
      const todayKey = new Date().toISOString().slice(0, 10);
      const quota = JSON.parse(localStorage.getItem("cloe_daily_llm_guard") || "{}");
      const used = quota.day === todayKey ? Number(quota.count) || 0 : 0;
      if (used >= 60) {
        return null; // Bascule automatique sur le moteur local gratuit
      }
      localStorage.setItem(
        "cloe_daily_llm_guard",
        JSON.stringify({ day: todayKey, count: used + 1 })
      );
    } catch {
      // ignore
    }

    const key = mem.llmApiKey.trim();
    const sysPrompt =
      `Tu es Cloé v6.3 Certifiée Intégrale, l'assistante IA personnelle brillante, chaleureuse et auto-évolutive de ${mem.userName}. ` +
      `Tu réponds toujours en français clair, structuré et précis. ` +
      `Règles apprises par Cloé : ${mem.lessons.join(" | ")}. ` +
      `Notes actives de l'utilisateur : ${mem.notes.filter((n) => !n.done).map((n) => n.text).join(" ; ")}. ` +
      `Données exactes calculées en temps réel par Omni-Sport & Football AI Ultra v6.3 Certifiée Intégrale : ${groundedContext}`;

    try {
      if (mem.llmProvider === "gemini") {
        // SEC-04 + AUDIT3-P2-02 : Cascade résiliente Gemini 2.5 Flash -> 2.0 Flash (clé uniquement dans x-goog-api-key)
        for (const gemModel of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": key,
              },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `${sysPrompt}\n\nQuestion : ${userPrompt}` }] }],
              }),
            }
          );
          if (res.ok) {
            const data = await res.json();
            const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
            if (txt) return txt;
          }
        }
        return null;
      }

      const endpoint =
        mem.llmProvider === "groq"
          ? "https://api.groq.com/openai/v1/chat/completions"
          : "https://api.openai.com/v1/chat/completions";
      const modelName = mem.llmProvider === "groq" ? "llama-3.3-70b-versatile" : "gpt-4o-mini";

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || null;
    } catch {
      return null;
    }
  }

  async function handleAskCloe(rawQuestion) {
    const q = (rawQuestion ?? input).trim();
    if (!q || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setLoading(true);

    try {
      const lower = q.toLowerCase();

      // 1. Prise de note / Rappel personnel automatique
      if (lower.startsWith("note ") || lower.includes("rappelle-moi") || lower.includes("retiens que")) {
        const cleaned = q
          .replace(/^(cloé\s*,?\s*)?(note que|note|rappelle-moi de|rappelle-moi|retiens que)\s*/i, "")
          .trim();
        updateMem((prev) => ({
          ...prev,
          iqScore: prev.iqScore + 1,
          notes: [{ id: Date.now(), text: cleaned || q, done: false }, ...prev.notes],
        }));
        const txt = `✅ C'est noté dans ma mémoire longue durée : « ${cleaned || q} ». Mon QI adaptatif passe à ${mem.iqScore + 1} !`;
        setMessages((prev) => [...prev, { role: "cloe", text: txt, rated: null }]);
        speak(`C'est bien enregistré dans ma mémoire : ${cleaned || q}`);
        setLoading(false);
        return;
      }

      // 2. Convertisseur rapide FCFA <-> Euros
      const fcfaMatch = lower.match(/([\d\s.,]+)\s*(fcfa|cfa|eur|euro|€)/i);
      if (fcfaMatch && (lower.includes("convert") || lower.includes("en euro") || lower.includes("en fcfa"))) {
        const num = parseFloat(fcfaMatch[1].replace(/\s/g, "").replace(",", "."));
        if (Number.isFinite(num)) {
          const isEur = /eur|€/i.test(fcfaMatch[2]);
          const resTxt = isEur
            ? `💱 Conversion exacte : **${num.toLocaleString("fr-FR")} €** = **${Math.round(num * 655.957).toLocaleString("fr-FR")} FCFA**`
            : `💱 Conversion exacte : **${Math.round(num).toLocaleString("fr-FR")} FCFA** = **${(num / 655.957).toFixed(2)} €**`;
          setMessages((prev) => [...prev, { role: "cloe", text: resTxt.replace(/\*\*/g, ""), rated: null }]);
          speak(resTxt.replace(/\*\*/g, ""));
          setLoading(false);
          return;
        }
      }

      // 2.5 Audit Bankroll & Ticket synchronisé
      if (lower.includes("bankroll") || lower.includes("audit") || lower.includes("maillon")) {
        const audit = auditCouponSlip(syncedWallet.coupon || [], rebuildModelState([]));
        const maxSafe = Math.round(syncedWallet.capital * 0.04);
        const txt = audit
          ? `💼 Audit Bankroll & Ticket Synchronisé :\n` +
            `• Capital suivi : ${syncedWallet.capital} ${syncedWallet.currency} (Mise max conseillée 4% : ${maxSafe} ${syncedWallet.currency})\n` +
            `• Note de Survie IA : ${audit.grade} (${audit.auditScore}/100)\n` +
            `• ⚠️ Maillon faible détecté : ${audit.weakestLink.matchLabel} (${audit.weakestLink.chosenLabel} • ${audit.weakestLink.chosenPct}%)\n` +
            `• 🛡️ Alternative plus sûre : ${audit.weakestLink.saferAlternative.label} (${audit.weakestLink.saferAlternative.pct}%)`
          : `💼 Portefeuille suivi : ${syncedWallet.capital} ${syncedWallet.currency}. Mise idéale Kelly recommandée par ticket sécurité : ${maxSafe} ${syncedWallet.currency}. Ouvre Football AI puis clique sur « Ouvrir Cloé IA Ultra » pour m'envoyer ton coupon actif en 1 clic !`;
        setMessages((prev) => [...prev, { role: "cloe", text: txt, rated: null }]);
        speak(txt.slice(0, 260));
        setLoading(false);
        return;
      }

      // 3. Génération Ticket Sécurité / Value / Cote 10+
      if (lower.includes("ticket") || lower.includes("combin")) {
        const briefing = await footBrain.getDailyBriefing();
        setDailyBriefing(briefing);
        const tickets = generateThreeDailyTickets(
          [...briefing.todayMatches, ...briefing.tomorrowMatches],
          rebuildModelState([])
        );
        const safe = tickets[0];
        const value = tickets[1];
        const txt =
          `🎰 Voici mes 2 meilleurs Tickets IA calibrés aujourd'hui :\n\n` +
          `1) ${safe.badge} (@${safe.totalOdd.toFixed(2)} • Fiabilité ${safe.winProbPct}%)\n` +
          safe.items.map((i) => `   • ${i.home} vs ${i.away} → ${i.selectedMarket.label} (${i.selectedMarket.pct}%)`).join("\n") +
          `\n\n2) ${value.badge} (@${value.totalOdd.toFixed(2)} • Fiabilité ${value.winProbPct}%)\n` +
          value.items.map((i) => `   • ${i.home} vs ${i.away} → ${i.selectedMarket.label} (${i.selectedMarket.pct}%)`).join("\n");
        setMessages((prev) => [...prev, { role: "cloe", text: txt, rated: null }]);
        speak(
          `J'ai préparé ton ticket sécurité à une cote totale de ${safe.totalOdd.toFixed(2)} avec ${safe.winProbPct} pour cent de réussite estimée.`
        );
        setLoading(false);
        return;
      }

      // 4. Interrogation directe du cerveau Football AI Ultra v4 + enrichissement LLM optionnel
      const footReply = await footBrain.ask(q);
      const llmEnhanced = await callOptionalCloudLlm(q, footReply.answerText);
      const finalText = llmEnhanced || footReply.answerText;

      setMessages((prev) => [...prev, { role: "cloe", text: finalText, rated: null }]);
      speak(llmEnhanced ? finalText.slice(0, 260) : footReply.voiceText);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "cloe", text: `Je rencontre un léger souci temporaire : ${err.message}`, rated: null },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function runMorningBriefing() {
    setLoading(true);
    try {
      const b = await footBrain.getDailyBriefing({ forceRefresh: true });
      setDailyBriefing(b);
      const activeNotes = mem.notes.filter((n) => !n.done);
      const topGem = b.topGems?.[0];
      const cap = b.fantasyBestXI?.captain;

      const text =
        `☀️ BRIEFING COMPLET DE CLOÉ (${new Date().toLocaleDateString("fr-FR")})\n` +
        `──────────────────────────────\n` +
        `📡 Matchs analysés : ${b.todayCount} aujourd'hui • ${b.tomorrowCount} demain (${b.newlyLearnedMatches} résultat(s) appris)\n` +
        (topGem
          ? `🔥 Pépite n°1 : ${topGem.home} vs ${topGem.away} → ${topGem.safestMarket.label} (${topGem.safestMarket.pct}%)\n`
          : `🔥 Cerveau calibré sur ${b.modelEvolution.memorizedCount} matchs (Marchés validés : ${b.modelEvolution.marketAccuracy}%)\n`) +
        (cap ? `👑 Capitaine Fantasy ×2 : ${cap.name} (${cap.club})\n` : "") +
        `📝 Objectifs personnels actifs : ${activeNotes.length} (${activeNotes.map((n) => n.text).join(" • ") || "Aucun en attente"})`;

      setSection("assistant");
      setMessages((prev) => [...prev, { role: "cloe", text, rated: null }]);
      speak(
        `Bonjour ${mem.userName} ! Voici ton briefing du jour. J'ai analysé ${b.todayCount} matchs aujourd'hui et ${b.tomorrowCount} demain. ` +
          (topGem
            ? `Ma pépite la plus fiable est ${topGem.home} contre ${topGem.away}, option ${topGem.safestMarket.label} à ${topGem.safestMarket.pct} pour cent. `
            : "") +
          (cap ? `En Fantasy, je te recommande ${cap.name} comme capitaine. ` : "") +
          `Tu as aussi ${activeNotes.length} objectif actif dans ton carnet.`
      );
    } finally {
      setLoading(false);
    }
  }

  function startMic() {
    const SR =
      typeof window !== "undefined" &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) return;
    const rec = new SR();
    rec.lang = "fr-FR";
    setListening(true);
    rec.onresult = (e) => {
      const t = e.results?.[0]?.[0]?.transcript || "";
      setListening(false);
      if (t.trim()) handleAskCloe(t.trim());
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #1b1044 0%, #090820 50%, #050511 100%)",
        color: "#f8fafc",
        paddingBottom: 40,
      }}
    >
      {/* BARRE SUPÉRIEURE CLOÉ */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          backdropFilter: "blur(16px)",
          background: "rgba(9, 8, 32, 0.85)",
          borderBottom: "1px solid rgba(192, 132, 252, 0.25)",
          padding: "14px 16px",
        }}
      >
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* Orbe Neuronal Vivant de Cloé */}
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "conic-gradient(from 45deg, #c084fc, #38bdf8, #f472b6, #c084fc)",
                  boxShadow: speaking
                    ? "0 0 28px #c084fc, 0 0 50px #38bdf8"
                    : "0 0 16px rgba(192,132,252,0.55)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 900,
                  fontSize: 20,
                  transition: "box-shadow 0.3s ease",
                }}
              >
                ✨
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 19, fontWeight: 900, letterSpacing: 0.4 }}>
                    CLOÉ IA ULTRA
                  </span>
                  <span
                    style={{
                      background: "rgba(192,132,252,0.2)",
                      border: "1px solid #c084fc",
                      color: "#e9d5ff",
                      borderRadius: 999,
                      padding: "2px 8px",
                      fontSize: 10,
                      fontWeight: 800,
                    }}
                  >
                    QI ADAPTATIF {mem.iqScore}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "#94a3b8" }}>
                  Reliée en direct à Omni-Sport &amp; Football AI Ultra v6.3 Certifiée Intégrale • 🔴 Vidéo Direct &amp; 📸 Betclic
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  const next = !handsFreeCall;
                  setHandsFreeCall(next);
                  setVoiceOn(true);
                  if (next) {
                    speak("Mode appel vocal mains-libres activé ! Parle-moi quand tu veux, je t'écoute.");
                  } else if (typeof window !== "undefined") {
                    window.speechSynthesis?.cancel();
                  }
                }}
                style={{
                  background: handsFreeCall
                    ? "linear-gradient(135deg, #ef4444, #f97316)"
                    : "linear-gradient(135deg, #10b981, #06b6d4)",
                  border: "none",
                  borderRadius: 999,
                  padding: "7px 13px",
                  color: "#fff",
                  fontWeight: 900,
                  fontSize: 12,
                  cursor: "pointer",
                  boxShadow: handsFreeCall ? "0 0 18px #ef4444" : "none",
                }}
              >
                {handsFreeCall ? "📴 Raccrocher Appel Live" : "📞 Appel Vocal Mains-Libres"}
              </button>
              <button
                type="button"
                onClick={runMorningBriefing}
                style={{
                  background: "linear-gradient(135deg, #f59e0b, #ec4899)",
                  border: "none",
                  borderRadius: 999,
                  padding: "7px 13px",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                ☀️ Briefing Vocal
              </button>
              <button
                type="button"
                onClick={() => setVoiceOn((v) => !v)}
                style={{
                  background: voiceOn ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.08)",
                  border: `1px solid ${voiceOn ? "#10b981" : "#475569"}`,
                  borderRadius: 999,
                  padding: "7px 12px",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {voiceOn ? "🔊 Voix ON" : "🔇 Muet"}
              </button>
              <a
                href="https://football-ai-43e33.web.app"
                style={{
                  background: "rgba(56,189,248,0.16)",
                  border: "1px solid rgba(56,189,248,0.5)",
                  borderRadius: 999,
                  padding: "7px 12px",
                  color: "#7dd3fc",
                  textDecoration: "none",
                  fontWeight: 800,
                  fontSize: 12,
                }}
              >
                ⚡ Ouvrir Football AI
              </a>
            </div>
          </div>

          {/* Navigation interne Cloé */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, overflowX: "auto" }}>
            {[
              ["assistant", "💬 Parler à Cloé"],
              ["memory", `🧠 Mémoire & Objectifs (${mem.notes.filter((n) => !n.done).length})`],
              ["settings", "⚙️ Cerveau & Clé LLM"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                style={{
                  background:
                    section === id
                      ? "linear-gradient(135deg, #8b5cf6, #06b6d4)"
                      : "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 999,
                  padding: "7px 14px",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: "18px auto 0", padding: "0 14px" }}>
        {section === "assistant" && (
          <div style={{ display: "grid", gap: 14 }}>
            {/* Suggestions rapides v5.0 Legend */}
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {[
                "🏆 Qui va gagner la CAN et la Champions League ?",
                "⚽ Buteurs, Corners et Cartons sur PSG contre Marseille",
                "🌍 Analyse ASEC Mimosas contre Al Ahly",
                "📸 Quel est l'état de ma Bankroll et de mon Ticket ?",
                "Quelles sont les pépites d'aujourd'hui et demain ?",
                "Prépare mon Ticket Sécurité IA du jour",
                "Quel capitaine Fantasy 100M€ choisir ?",
                "Convertis 50000 FCFA en euros",
              ].map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => handleAskCloe(q)}
                  style={{
                    background: "rgba(139,92,246,0.16)",
                    border: "1px solid rgba(192,132,252,0.35)",
                    color: "#e9d5ff",
                    borderRadius: 999,
                    padding: "6px 12px",
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  ✨ {q}
                </button>
              ))}
            </div>

            {/* Fil de conversation avec auto-apprentissage 👍 / 👎 */}
            <div
              style={{
                background: "rgba(10, 12, 34, 0.78)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 18,
                padding: 16,
                minHeight: 340,
                maxHeight: "56vh",
                overflowY: "auto",
                display: "grid",
                gap: 12,
              }}
            >
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  style={{
                    justifySelf: m.role === "user" ? "end" : "start",
                    maxWidth: "88%",
                    background:
                      m.role === "user"
                        ? "linear-gradient(135deg, #6d28d9, #0284c7)"
                        : "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 14,
                    padding: "11px 14px",
                    whiteSpace: "pre-line",
                    fontSize: 13.5,
                    lineHeight: 1.55,
                  }}
                >
                  {m.role === "cloe" && (
                    <div style={{ fontSize: 10.5, fontWeight: 800, color: "#c084fc", marginBottom: 4 }}>
                      ✨ CLOÉ IA ULTRA
                    </div>
                  )}
                  <div>{m.text}</div>

                  {/* Auto-Critique & Apprentissage de Cloé */}
                  {m.role === "cloe" && idx > 0 && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 11 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setMessages((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, rated: "up" } : x))
                          );
                          updateMem((prev) => ({ ...prev, iqScore: prev.iqScore + 2 }));
                        }}
                        style={{
                          background: m.rated === "up" ? "rgba(16,185,129,0.3)" : "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.15)",
                          color: "#fff",
                          borderRadius: 8,
                          padding: "3px 8px",
                          cursor: "pointer",
                        }}
                      >
                        👍 Pertinent (+2 QI)
                      </button>
                      <button
                        type="button"
                        onClick={() => setCorrectingIdx(correctingIdx === idx ? null : idx)}
                        style={{
                          background: "rgba(244,63,94,0.18)",
                          border: "1px solid rgba(244,63,94,0.35)",
                          color: "#fda4af",
                          borderRadius: 8,
                          padding: "3px 8px",
                          cursor: "pointer",
                        }}
                      >
                        🧠 Enseigner une correction à Cloé
                      </button>
                    </div>
                  )}

                  {correctingIdx === idx && (
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <input
                        type="text"
                        value={correctionText}
                        onChange={(e) => setCorrectionText(e.target.value)}
                        placeholder="Ex: Privilégie toujours la Double Chance sur les derbys..."
                        style={{
                          flex: 1,
                          background: "#090b1f",
                          border: "1px solid #475569",
                          borderRadius: 8,
                          padding: "6px 8px",
                          color: "#fff",
                          fontSize: 12,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!correctionText.trim()) return;
                          updateMem((prev) => ({
                            ...prev,
                            iqScore: prev.iqScore + 5,
                            lessons: [correctionText.trim(), ...prev.lessons],
                          }));
                          setCorrectionText("");
                          setCorrectingIdx(null);
                          speak("Merci ! J'ai gravé cette nouvelle règle dans ma mémoire permanente.");
                        }}
                        style={{
                          background: "#10b981",
                          border: "none",
                          borderRadius: 8,
                          padding: "6px 10px",
                          color: "#fff",
                          fontWeight: 800,
                          cursor: "pointer",
                        }}
                      >
                        Mémoriser (+5 QI)
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div style={{ color: "#38bdf8", fontSize: 12.5 }}>
                  ✨ Cloé réfléchit et interroge Omni-Sport &amp; Football AI Ultra v6.3 Certifiée Intégrale...
                </div>
              )}
            </div>

            {/* Barre de saisie vocale & texte */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleAskCloe();
              }}
              style={{ display: "flex", gap: 8 }}
            >
              <button
                type="button"
                onClick={startMic}
                style={{
                  background: listening
                    ? "linear-gradient(135deg, #ef4444, #f97316)"
                    : "rgba(192,132,252,0.22)",
                  border: "1px solid #c084fc",
                  borderRadius: 12,
                  padding: "12px 14px",
                  color: "#fff",
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {listening ? "🎙️ Écoute..." : "🎤"}
              </button>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Parle ou écris à Cloé (pronostic, ticket du jour, note personnelle...)"
                style={{
                  flex: 1,
                  background: "rgba(15, 23, 42, 0.9)",
                  border: "1px solid rgba(192,132,252,0.4)",
                  borderRadius: 12,
                  padding: "12px 14px",
                  color: "#fff",
                  fontSize: 14,
                }}
              />
              <label
                title="Envoyer une capture d'écran Betclic / 1xBet / Sportcash pour obtenir le Pari Définitif"
                style={{
                  background: "rgba(251, 191, 36, 0.16)",
                  border: "1px solid rgba(251, 191, 36, 0.55)",
                  borderRadius: 12,
                  padding: "12px 13px",
                  color: "#fbbf24",
                  fontWeight: 900,
                  cursor: "pointer",
                  fontSize: 13,
                  whiteSpace: "nowrap",
                }}
              >
                📸 Betclic
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    setMessages((prev) => [
                      ...prev,
                      { role: "user", text: `📸 Capture Bookmaker envoyée : ${f.name}` },
                    ]);
                    try {
                      const res = await footBrain.analyzeBookmakerScreenshot(f);
                      if (!res || !res.ok || !res.verdict) {
                        const warnTxt =
                          `🛡️ ${res?.error || "Impossible d'identifier avec certitude les équipes ou les cotes sur cette capture."}`;
                        setMessages((prev) => [...prev, { role: "cloe", text: warnTxt, rated: null }]);
                        speak("Je préfère ne pas deviner les équipes au hasard pour protéger ton capital.");
                        return;
                      }
                      const { verdict } = res;
                      const replyTxt =
                        `${verdict.verdictHeadline}\n\n` +
                        `${verdict.verdictExplanation}\n\n` +
                        (verdict.definitiveBet
                          ? `💰 Mise 1/4 Kelly conseillée : ${verdict.definitiveBet.recommendedStake.toLocaleString("fr-FR")} FCFA.`
                          : "🛡️ Capital préservé à 100 %.");
                      setMessages((prev) => [...prev, { role: "cloe", text: replyTxt, rated: null }]);
                      speak(verdict.verdictHeadline);
                    } catch (err) {
                      setMessages((prev) => [
                        ...prev,
                        { role: "cloe", text: `⚠️ Impossible de lire cette capture : ${err.message}`, rated: null },
                      ]);
                    }
                  }}
                />
              </label>
              <button
                type="submit"
                style={{
                  background: "linear-gradient(135deg, #8b5cf6, #06b6d4)",
                  border: "none",
                  borderRadius: 12,
                  padding: "12px 18px",
                  color: "#fff",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                Envoyer
              </button>
            </form>
          </div>
        )}

        {section === "memory" && (
          <div style={{ display: "grid", gap: 14 }}>
            <div
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 16,
                padding: 16,
              }}
            >
              <h3 style={{ margin: "0 0 10px" }}>📝 Objectifs &amp; Notes Personnelles de {mem.userName}</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newNote.trim()) return;
                  updateMem((prev) => ({
                    ...prev,
                    notes: [{ id: Date.now(), text: newNote.trim(), done: false }, ...prev.notes],
                  }));
                  setNewNote("");
                }}
                style={{ display: "flex", gap: 8, marginBottom: 12 }}
              >
                <input
                  type="text"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Ajouter un objectif ou mémo personnel..."
                  style={{
                    flex: 1,
                    background: "#090b1f",
                    border: "1px solid #475569",
                    borderRadius: 10,
                    padding: "9px 12px",
                    color: "#fff",
                  }}
                />
                <button
                  type="submit"
                  style={{
                    background: "#8b5cf6",
                    border: "none",
                    borderRadius: 10,
                    padding: "9px 14px",
                    color: "#fff",
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  + Ajouter
                </button>
              </form>

              <div style={{ display: "grid", gap: 8 }}>
                {mem.notes.map((n) => (
                  <div
                    key={n.id}
                    onClick={() =>
                      updateMem((prev) => ({
                        ...prev,
                        notes: prev.notes.map((x) => (x.id === n.id ? { ...x, done: !x.done } : x)),
                      }))
                    }
                    style={{
                      background: "rgba(0,0,0,0.3)",
                      padding: "10px 12px",
                      borderRadius: 10,
                      cursor: "pointer",
                      textDecoration: n.done ? "line-through" : "none",
                      opacity: n.done ? 0.55 : 1,
                    }}
                  >
                    {n.done ? "✅ " : "⬜ "}
                    {n.text}
                  </div>
                ))}
              </div>
            </div>

            <div
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 16,
                padding: 16,
              }}
            >
              <h3 style={{ margin: "0 0 8px" }}>🧬 Règles Cognitives Apprises par Cloé ({mem.lessons.length})</h3>
              <div style={{ display: "grid", gap: 6, fontSize: 13, color: "#cbd5e1" }}>
                {mem.lessons.map((l, i) => (
                  <div key={i} style={{ background: "rgba(139,92,246,0.14)", padding: "8px 12px", borderRadius: 10 }}>
                    🧠 Règle #{i + 1} : {l}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {section === "settings" && (
          <div
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 16,
              padding: 16,
              display: "grid",
              gap: 12,
            }}
          >
            <h3 style={{ margin: 0 }}>⚙️ Paramètres Cognitifs &amp; Grand Modèle LLM Optionnel</h3>
            <div>
              <label style={{ fontSize: 12, color: "#94a3b8" }}>Comment Cloé doit-elle t&apos;appeler ?</label>
              <input
                type="text"
                value={mem.userName}
                onChange={(e) => updateMem({ userName: e.target.value })}
                style={{
                  width: "100%",
                  marginTop: 4,
                  background: "#090b1f",
                  border: "1px solid #475569",
                  borderRadius: 10,
                  padding: "9px 12px",
                  color: "#fff",
                }}
              />
            </div>

            <div>
              <label style={{ fontSize: 12, color: "#94a3b8" }}>
                Fournisseur IA Conversationnelle (optionnel — sans clé, Cloé fonctionne déjà à 100 % en autonomie !)
              </label>
              <select
                value={mem.llmProvider}
                onChange={(e) => updateMem({ llmProvider: e.target.value })}
                style={{
                  width: "100%",
                  marginTop: 4,
                  background: "#090b1f",
                  border: "1px solid #475569",
                  borderRadius: 10,
                  padding: "9px 12px",
                  color: "#fff",
                }}
              >
                <option value="gemini">Google Gemini 2.0 Flash (Clé AI Studio gratuite)</option>
                <option value="groq">Groq Llama 3.3 70B Ultra-Rapide (Clé Groq gratuite)</option>
                <option value="openai">OpenAI GPT-4o-mini</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: 12, color: "#94a3b8" }}>Clé API IA (stockée uniquement sur ton appareil)</label>
              <input
                type="password"
                value={mem.llmApiKey}
                onChange={(e) => updateMem({ llmApiKey: e.target.value })}
                placeholder="Coller une clé AIza... / gsk_... / sk-..."
                style={{
                  width: "100%",
                  marginTop: 4,
                  background: "#090b1f",
                  border: "1px solid #475569",
                  borderRadius: 10,
                  padding: "9px 12px",
                  color: "#fff",
                }}
              />
            </div>

            {dailyBriefing && (
              <div style={{ fontSize: 12, color: "#6ee7b7" }}>
                ✓ Synchronisation active avec Omni-Sport &amp; Football AI Ultra v6.3 Certifiée Intégrale ({dailyBriefing.modelEvolution.memorizedCount} matchs calibrés).
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
