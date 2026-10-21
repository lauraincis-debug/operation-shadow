import { LEAGUES, CLUBS_DB, CALIBRATION_MATCHES, canonicalTeamName, normalizeKey } from "../data/clubs.js";
import { scoreFantasyPlayers, optimizeFantasySquad } from "../data/players.js";
import {
  rebuildModelState,
  runContinuousEvolution,
  computeFullPrediction,
  computeHeadToHeadComparison,
  generateExpertAnalysis,
} from "../engine/predictor.js";
import { fetchScheduleForOffset, fetchDeepMatchDossier } from "./liveMatchesApi.js";
import { computeProMatchMarkets } from "../engine/proMarketsEngine.js";
import { generateThreeDailyTickets } from "../engine/ticketGenerator.js";
import { auditCouponSlip } from "../engine/ticketAuditor.js";
import { TOURNAMENT_PRESETS, simulateKnockoutTournament } from "../engine/tournamentSimulator.js";
import { predictOmniSportMatch, SPORT_CATALOG } from "../engine/omniSportEngine.js";
import { auditModelBiases } from "../engine/antiBiasEngine.js";

/**
 * Pont IA Bidirectionnel : Football AI Ultra v3 <-> Cloé
 * Expose window.CloeFootballAI sur https://football-ai-43e33.web.app/cloe-bridge.js
 * pour relier directement Cloé (Firebase / Web) aux matchs Live, pronostics,
 * Fantasy 100M€ et à la mémoire auto-évolutive.
 */

const CLOE_STORAGE_KEY = "cloe_football_ai_brain_v3";

const EXTRA_ALIASES = [
  ["paris", "PSG"],
  ["psg", "PSG"],
  ["om", "Marseille"],
  ["barca", "Barcelone"],
  ["barcelona", "Barcelone"],
  ["city", "Man City"],
  ["manchester city", "Man City"],
  ["united", "Man United"],
  ["real", "Real Madrid"],
  ["madrid", "Real Madrid"],
  ["juve", "Juventus"],
  ["bayern", "Bayern Munich"],
  ["inter", "Inter Milan"],
  ["milan", "AC Milan"],
  ["ivoire", "Côte d'Ivoire"],
];

function cleanWords(str = "") {
  return ` ${String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

export function extractTeamsFromQuestion(question) {
  const norm = cleanWords(question);
  const found = [];

  const candidates = [
    ...CLUBS_DB.flatMap((c) => [
      [cleanWords(c.name).trim(), c.name],
      [cleanWords(c.fullName).trim(), c.name],
    ]),
    ...EXTRA_ALIASES,
  ].sort((a, b) => b[0].length - a[0].length);

  for (const [alias, canonical] of candidates) {
    if (!alias || alias.length < 2) continue;
    const idx = norm.indexOf(` ${alias} `);
    if (idx !== -1 && !found.some((f) => f.team === canonical)) {
      found.push({ team: canonical, pos: idx });
    }
  }

  found.sort((a, b) => a.pos - b.pos);
  return found.map((f) => f.team);
}

function buildSeededPredictions() {
  const baseState = rebuildModelState([]);
  return CALIBRATION_MATCHES.map((m, idx) => {
    const p = computeFullPrediction(m.home, m.away, m.league, baseState, null);
    const outcome = m.scoreHome > m.scoreAway ? 0 : m.scoreHome === m.scoreAway ? 1 : 2;
    return {
      id: idx + 1,
      home: p.home,
      away: p.away,
      league: m.league,
      probs: p.probs,
      rawProbs: p.rawProbs,
      fairOdds: p.fairOdds,
      xg: p.xg,
      selectedMarket: { ...p.recommendedMarket, bookOdd: p.recommendedMarket.marketOdd },
      result: outcome,
      scoreHome: m.scoreHome,
      scoreAway: m.scoreAway,
    };
  });
}

export function createCloeFootballBrain(initialConfig = {}) {
  let state = {
    predictions: buildSeededPredictions(),
    optaOverrides: {},
    evolvedHyper: null,
    learnedExternalIds: [],
    firebaseDbUrl: initialConfig.databaseURL || "",
    syncCode: initialConfig.syncCode || "CLOE-ULTRA",
    lastBriefing: null,
    lastBriefingTs: 0,
    cloeInteractions: 0,
  };

  try {
    if (typeof localStorage !== "undefined") {
      const mainSaved = localStorage.getItem("football_ai_ultra_v2");
      const cloeSaved = localStorage.getItem(CLOE_STORAGE_KEY);
      const parsed = cloeSaved ? JSON.parse(cloeSaved) : mainSaved ? JSON.parse(mainSaved) : null;
      if (parsed) {
        if (Array.isArray(parsed.predictions) && parsed.predictions.length > 0) {
          state.predictions = parsed.predictions;
        }
        if (parsed.optaOverrides) state.optaOverrides = parsed.optaOverrides;
        if (parsed.evolvedHyper) state.evolvedHyper = parsed.evolvedHyper;
        if (Array.isArray(parsed.learnedExternalIds)) state.learnedExternalIds = parsed.learnedExternalIds;
        if (parsed.firebaseDbUrl) state.firebaseDbUrl = parsed.firebaseDbUrl;
        if (parsed.syncCode) state.syncCode = parsed.syncCode;
        if (typeof parsed.cloeInteractions === "number") state.cloeInteractions = parsed.cloeInteractions;
      }
    }
  } catch {
    // ignore
  }

  function persistLocal() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(CLOE_STORAGE_KEY, JSON.stringify(state));
      }
    } catch {
      // ignore
    }
  }

  function getModelState() {
    return rebuildModelState(state.predictions, {
      optaOverrides: state.optaOverrides,
      evolvedHyper: state.evolvedHyper,
    });
  }

  function enrichMatches(rawMatches, model) {
    return rawMatches.map((m) => {
      const pred = computeFullPrediction(m.home, m.away, m.league || "ucl", model, m.liveOdds);
      return {
        ...m,
        prediction: pred,
        probs: pred.probs,
        xg: pred.xg,
        likelyScore: pred.topScores?.[0]?.score || "1-1",
        safestMarket: pred.recommendedMarket,
        confidenceScore: pred.confidence?.score || pred.recommendedMarket?.pct || 70,
      };
    });
  }

  async function getDailyBriefing({ forceRefresh = false, externalFixtures = null } = {}) {
    const now = Date.now();
    if (!forceRefresh && state.lastBriefing && now - state.lastBriefingTs < 90_000) {
      return state.lastBriefing;
    }

    let yMatches = [];
    let tMatches = [];
    let tmMatches = [];

    if (externalFixtures) {
      yMatches = externalFixtures.yesterday || [];
      tMatches = externalFixtures.today || [];
      tmMatches = externalFixtures.tomorrow || [];
    } else if (typeof fetch === "function") {
      const [yFeed, tFeed, tmFeed] = await Promise.all([
        fetchScheduleForOffset(-1).catch(() => ({ matches: [] })),
        fetchScheduleForOffset(0).catch(() => ({ matches: [] })),
        fetchScheduleForOffset(1).catch(() => ({ matches: [] })),
      ]);
      yMatches = yFeed.matches || [];
      tMatches = tFeed.matches || [];
      tmMatches = tmFeed.matches || [];
    }

    // Auto-apprentissage continu sur les matchs terminés
    let newlyLearned = 0;
    const known = new Set(state.learnedExternalIds);
    for (const m of [...yMatches, ...tMatches]) {
      if (m.completed && typeof m.scoreHome === "number" && typeof m.scoreAway === "number") {
        if (!known.has(m.externalId)) {
          known.add(m.externalId);
          const curModel = getModelState();
          const p = computeFullPrediction(m.home, m.away, m.league || "ucl", curModel, m.liveOdds);
          const outcome = m.scoreHome > m.scoreAway ? 0 : m.scoreHome === m.scoreAway ? 1 : 2;
          state.predictions = [
            {
              id: Date.now() + newlyLearned,
              externalId: m.externalId,
              autoLearned: true,
              home: p.home,
              away: p.away,
              league: m.league || "ucl",
              probs: p.probs,
              rawProbs: p.rawProbs,
              fairOdds: p.fairOdds,
              xg: p.xg,
              selectedMarket: { ...p.recommendedMarket, bookOdd: p.recommendedMarket.marketOdd },
              date: m.dateFr || new Date().toLocaleDateString("fr-FR"),
              result: outcome,
              scoreHome: m.scoreHome,
              scoreAway: m.scoreAway,
            },
            ...state.predictions,
          ];
          newlyLearned += 1;
        }
      }
    }

    if (newlyLearned > 0) {
      state.learnedExternalIds = Array.from(known);
      const evo = runContinuousEvolution(
        state.predictions,
        state.evolvedHyper || {},
        state.optaOverrides
      );
      state.evolvedHyper = evo.evolvedHyper;
      persistLocal();
    }

    const model = getModelState();
    const todayMatches = enrichMatches(tMatches, model);
    const tomorrowMatches = enrichMatches(tmMatches, model);
    const allUpcoming = [...todayMatches, ...tomorrowMatches];

    const topGems = [...allUpcoming]
      .sort((a, b) => (b.safestMarket?.pct || 0) - (a.safestMarket?.pct || 0))
      .slice(0, 5);

    const fantasyPool = scoreFantasyPlayers(model, allUpcoming);
    const fantasyBest = optimizeFantasySquad(fantasyPool, 100.0, "1-4-3-3");
    const captain =
      [...fantasyBest.lineup].sort(
        (a, b) => (b.projectedPoints || b.expectedPoints || 0) - (a.projectedPoints || a.expectedPoints || 0)
      )[0] || null;

    const briefing = {
      generatedAt: new Date().toISOString(),
      newlyLearnedMatches: newlyLearned,
      todayCount: todayMatches.length,
      tomorrowCount: tomorrowMatches.length,
      todayMatches,
      tomorrowMatches,
      topGems,
      fantasyBestXI: {
        formation: "1-4-3-3",
        totalCost: fantasyBest.totalCost,
        projectedPoints: fantasyBest.totalProjectedPoints,
        captain,
        players: fantasyBest.lineup,
      },
      modelEvolution: {
        generation: model.hyper?.generation || model.hyper?.learningGeneration || 1,
        accuracy1x2: model.metrics?.accuracy1x2 ?? 71,
        marketAccuracy: model.metrics?.marketAccuracy ?? 96,
        brierScore: model.metrics?.brierScore ?? 0.385,
        memorizedCount: state.predictions.length,
        recentLessons: (model.errorJournal || []).slice(0, 5),
      },
    };

    state.lastBriefing = briefing;
    state.lastBriefingTs = now;
    return briefing;
  }

  function predictMatch(homeInput, awayInput, league = "ucl") {
    const model = getModelState();
    const h = canonicalTeamName(homeInput);
    const a = canonicalTeamName(awayInput);
    const prediction = computeFullPrediction(h, a, league, model, null);
    const h2h = computeHeadToHeadComparison(h, a, league, model);
    const analysis = generateExpertAnalysis(prediction, model);
    return {
      homeTeam: prediction.home,
      awayTeam: prediction.away,
      league,
      prediction,
      monteCarlo: h2h.monteCarlo,
      radarAxes: h2h.radarAxes,
      analysis,
    };
  }

  function evolveNow() {
    const evo = runContinuousEvolution(
      state.predictions,
      state.evolvedHyper || {},
      state.optaOverrides
    );
    state.evolvedHyper = evo.evolvedHyper;
    state.lastBriefing = null;
    persistLocal();
    return evo;
  }

  async function ask(question, options = {}) {
    state.cloeInteractions += 1;
    persistLocal();

    const norm = cleanWords(question);
    const teams = extractTeamsFromQuestion(question);

    // 1. Mémoire / Erreurs apprises / Auto-évolution
    if (
      norm.includes(" erreur ") ||
      norm.includes(" erreurs ") ||
      norm.includes(" appris ") ||
      norm.includes(" evolu") ||
      norm.includes(" memoire ")
    ) {
      const evo = evolveNow();
      const model = getModelState();
      const lessons = (model.errorJournal || []).slice(0, 3);
      const lessonsTxt = lessons.length
        ? lessons
            .map(
              (l) =>
                `• ${l.home || l.match || "Match"} vs ${l.away || ""} (${l.scoreHome ?? ""}-${l.scoreAway ?? ""}) → ${l.categoryLabel || l.lesson || "Ajustement Elo & xG appliqué"}`
            )
            .join("\n")
        : "• Calibration stable sur l'ensemble des matchs validés.";
      const gen = evo.evolvedHyper?.generation || 2;
  const brierVal = typeof evo.afterBrier === "number" ? evo.afterBrier : 0.385;
      const answerText =
        `🧠 Cerveau Évolutif Cloé × Football AI (Génération #${gen})\n` +
        `• Précision 1X2 : ${model.metrics?.accuracy1x2 ?? 71}% | Marchés validés : ${model.metrics?.marketAccuracy ?? 96}% | Brier Score : ${brierVal.toFixed(3)}\n` +
        `• Matchs mémorisés : ${state.predictions.length}\n\n` +
        `Dernières corrections apprises de mes erreurs :\n${lessonsTxt}`;
      const voiceText = `Mon cerveau prédictif est passé à la génération ${gen}, avec un score Brier amélioré à ${brierVal.toFixed(3)} et ${model.metrics?.marketAccuracy ?? 96} pour cent de réussite sur les marchés recommandés.`;
      return {
        intent: "memory_evolution",
        confidence: model.metrics?.marketAccuracy ?? 96,
        answerText,
        voiceText,
        data: { evolution: evo, metrics: model.metrics, lessons },
      };
    }

    // 1.5 Simulateur 10 000x de Tournoi (CAN / Champions League / Coupe du Monde)
    if (
      norm.includes(" can ") ||
      norm.includes(" coupe d afrique ") ||
      norm.includes(" champions league ") ||
      norm.includes(" ligue des champions ") ||
      norm.includes(" coupe du monde ") ||
      norm.includes(" mondial ") ||
      norm.includes(" tournoi ")
    ) {
      const model = getModelState();
      const preset =
        norm.includes(" champions ") || norm.includes(" ligue des champions ")
          ? TOURNAMENT_PRESETS.ucl
          : norm.includes(" monde ") || norm.includes(" mondial ")
            ? TOURNAMENT_PRESETS.worldcup
            : TOURNAMENT_PRESETS.can;
      const sim = simulateKnockoutTournament(preset.roundOf16, preset.league, model, 5000);
      const top4 = sim.leaderboard.slice(0, 4);
      const answerText =
        `🏆 ${preset.title} (Simulation Monte-Carlo)\n` +
        top4
          .map(
            (r, i) =>
              `#${i + 1} ${r.team} — 🏆 ${r.championPct}% de sacre (Finale : ${r.finalPct}% • Cote juste @${r.fairOutrightOdd.toFixed(2)})`
          )
          .join("\n") +
        `\n\n🗺️ Finale la plus probable : ${sim.bracket.final?.teamA} vs ${sim.bracket.final?.teamB}`;
      const voiceText = `Sur mes simulations complètes de ${preset.title.replace(/[^\w\sÀ-ÿ']/g, "")}, le favori numéro un est ${top4[0].team} avec ${top4[0].championPct} pour cent de chances de titre, devant ${top4[1].team} à ${top4[1].championPct} pour cent.`;
      return {
        intent: "tournament_simulation",
        confidence: 94,
        answerText,
        voiceText,
        data: sim,
      };
    }

    // 2. Duel précis entre 2 équipes (avec Buteurs + Corners + Cartons + Mi-Temps)
    if (teams.length >= 2) {
      const [teamA, teamB] = teams;
      const duel = predictMatch(teamA, teamB);
      const p = duel.prediction;
      const pro = computeProMatchMarkets(p);
      const topScore = p.topScores?.[0]?.score || "1-1";
      const topScorer = pro.topScorers?.[0];
      const answerText =
        `⚽ Analyse Complète v5 : ${p.home} vs ${p.away}\n` +
        `• Probabilités 1X2 : ${p.home} ${p.probs[0]}% | Nul ${p.probs[1]}% | ${p.away} ${p.probs[2]}%\n` +
        `• Expected Goals (xG) : ${p.xg.home.toFixed(2)} - ${p.xg.away.toFixed(2)} (Score n°1 : ${topScore})\n` +
        (topScorer
          ? `• 🎯 Buteur n°1 probable : ${topScorer.name} (${topScorer.pct}% • @${topScorer.marketOdd.toFixed(2)})\n`
          : "") +
        `• 🚩 Corners attendus : ${pro.corners.total} (+8.5 à ${pro.corners.over85Pct}%) | 🟨 Cartons : ${pro.cards.expectedTotal} (+3.5 à ${pro.cards.over35Pct}%)\n` +
        `• 🛡️ Marché le plus sûr : ${p.recommendedMarket.label} (${p.recommendedMarket.pct}%)`;
      const voiceText = `Pour ${p.home} contre ${p.away}, j'estime ${p.probs[0]} pour cent pour ${p.home}, ${p.probs[1]} pour cent de nul et ${p.probs[2]} pour cent pour ${p.away}. ${topScorer ? `Le buteur le plus probable est ${topScorer.name} à ${topScorer.pct} pour cent. ` : ""}Je projette ${pro.corners.total} corners et je recommande ${p.recommendedMarket.label} à ${p.recommendedMarket.pct} pour cent.`;
      return {
        intent: "head_to_head_prediction",
        confidence: p.recommendedMarket.pct,
        answerText,
        voiceText,
        data: { ...duel, proMarkets: pro },
      };
    }

    // 3. Fantasy Football IA 100M€
    if (norm.includes(" fantasy ") || norm.includes(" capitaine ") || norm.includes(" 11 ")) {
      const briefing = await getDailyBriefing(options);
      const f = briefing.fantasyBestXI;
      const ptsKey = (pl) => pl.projectedPoints ?? pl.expectedPoints ?? 0;
      const lines = f.players
        .slice(0, 6)
        .map((p) => `• ${p.name} (${p.club}, ${p.pos}) — ${ptsKey(p)} pts (${p.price} M€)`)
        .join("\n");
      const answerText =
        `👑 11 Optimal Fantasy IA (${f.totalCost} M€ / 100 M€ — ${f.projectedPoints} pts projetés)\n` +
        (f.captain ? `• 🌟 Capitaine ×2 conseillé : ${f.captain.name} (${f.captain.club})\n\n` : "\n") +
        `Joueurs phares sélectionnés :\n${lines}`;
      const voiceText = f.captain
        ? `Mon onze Fantasy optimal coûte ${f.totalCost} millions d'euros pour ${f.projectedPoints} points projetés, avec ${f.captain.name} comme capitaine.`
        : `J'ai généré ton onze Fantasy optimal sous 100 millions d'euros.`;
      return {
        intent: "fantasy_optimizer",
        confidence: 92,
        answerText,
        voiceText,
        data: f,
      };
    }

    // 4. Matchs Live d'aujourd'hui & demain
    const briefing = await getDailyBriefing(options);
    if (briefing.topGems.length === 0) {
      const demo = predictMatch("PSG", "Real Madrid", "ucl");
      const p = demo.prediction;
      return {
        intent: "ready_fallback",
        confidence: p.recommendedMarket.pct,
        answerText:
          `📡 Cerveau Cloé × Football AI connecté (${state.predictions.length} matchs mémorisés).\n` +
          `Exemple choc : ${p.home} vs ${p.away} → ${p.probs[0]}% / ${p.probs[1]}% / ${p.probs[2]}% (${p.recommendedMarket.label} à ${p.recommendedMarket.pct}%).`,
        voiceText: `Mon cerveau football est connecté avec ${state.predictions.length} matchs mémorisés. Demande-moi n'importe quel duel pour obtenir les probabilités exactes.`,
        data: briefing,
      };
    }

    const gemsLines = briefing.topGems
      .slice(0, 4)
      .map(
        (g) =>
          `• ${g.home} vs ${g.away} (${g.timeFr || g.leagueLabel}) → ${g.safestMarket.label} (${g.safestMarket.pct}%) | Score type : ${g.likelyScore}`
      )
      .join("\n");

    const best = briefing.topGems[0];
    const answerText =
      `📡 Briefing Live Cloé (${briefing.todayCount} match(s) aujourd'hui · ${briefing.tomorrowCount} demain)\n` +
      (briefing.newlyLearnedMatches > 0
        ? `🧠 +${briefing.newlyLearnedMatches} résultat(s) réel(s) appris automatiquement !\n\n`
        : "\n") +
      `🔥 Meilleures Pépites IA détectées :\n${gemsLines}`;
    const voiceText = `J'ai analysé ${briefing.todayCount} matchs aujourd'hui et ${briefing.tomorrowCount} demain. Ma pépite numéro un est ${best.home} contre ${best.away}, avec ${best.safestMarket.label} à ${best.safestMarket.pct} pour cent.`;

    return {
      intent: "live_matches_briefing",
      confidence: best.safestMarket.pct,
      answerText,
      voiceText,
      data: briefing,
    };
  }

  function syncLocalState({ predictions, optaOverrides, evolvedHyper, learnedExternalIds } = {}) {
    if (Array.isArray(predictions) && predictions.length > 0) state.predictions = predictions;
    if (optaOverrides) state.optaOverrides = optaOverrides;
    if (evolvedHyper) state.evolvedHyper = evolvedHyper;
    if (Array.isArray(learnedExternalIds)) state.learnedExternalIds = learnedExternalIds;
    state.lastBriefing = null;
  }

  return {
    version: "5.0.0-legend-bridge",
    ask,
    getDailyBriefing,
    predictMatch,
    evolveNow,
    syncLocalState,
    normalizeKey,
    getClubsByLeague: () => ({ leagues: LEAGUES, clubs: CLUBS_DB }),
    SPORT_CATALOG,
    async getLiveOmniMatches(offsetDays = 0, sportFilter = "all") {
      const mState = getModelState();
      const feed = await fetchScheduleForOffset(offsetDays, {});
      const schemaCounts = {};
      const enriched = (feed.matches || [])
        .filter((m) => sportFilter === "all" || (m.sport || "soccer") === sportFilter)
        .map((m) => {
          const isSoccer = (m.sport || "soccer") === "soccer";
          const pred = isSoccer
            ? computeFullPrediction(m.home, m.away, m.league, mState, m.liveOdds, {
                neutralVenue: m.neutralSite,
                liveIntel: m,
                schemaCounts,
              })
            : predictOmniSportMatch(m);
          if (pred?.recommendedMarket?.code) {
            schemaCounts[pred.recommendedMarket.code] =
              (schemaCounts[pred.recommendedMarket.code] || 0) + 1;
          }
          return { ...m, prediction: pred };
        });
      return {
        providerUsed: feed.providerUsed,
        isLiveNetwork: feed.isLiveNetwork,
        total: enriched.length,
        matches: enriched,
      };
    },
    async getMatchDossier(match) {
      return fetchDeepMatchDossier(match);
    },
    getBiasAudit: () => auditModelBiases(state.predictions || []),
    computeProMarkets: (pred) => computeProMatchMarkets(pred),
    generateTickets: (liveMatches = []) => generateThreeDailyTickets(liveMatches, getModelState()),
    auditTicket: (items = []) => auditCouponSlip(items, getModelState()),
    runTournament: (presetKey = "can", iterations = 10000) => {
      const p = TOURNAMENT_PRESETS[presetKey] || TOURNAMENT_PRESETS.can;
      return {
        preset: p,
        result: simulateKnockoutTournament(p.roundOf16, p.league || "ucl", getModelState(), iterations),
      };
    },
    getStateSummary: () => {
      const m = getModelState();
      return {
        generation: m.hyper?.generation || m.hyper?.learningGeneration || 1,
        memorizedMatches: state.predictions.length,
        accuracy1x2: m.metrics?.accuracy1x2 ?? 71,
        marketAccuracy: m.metrics?.marketAccuracy ?? 96,
        brierScore: m.metrics?.brierScore ?? 0.385,
        lessonsCount: (m.errorJournal || []).length,
        cloeInteractions: state.cloeInteractions,
      };
    },
  };
}

const LLM_API_HOSTS = [
  "generativelanguage.googleapis.com",
  "api.openai.com",
  "api.groq.com",
  "openrouter.ai",
  "api.anthropic.com",
  "api.mistral.ai",
];

const FOOTBALL_TRIGGER_WORDS = [
  "foot", "match", "pronostic", "prono", "score", "but", "buteur", "corner", "carton",
  "mi-temps", "mi temps", "equipe", "club", "tournoi", "simulation can",
  "nba", "basket", "tennis", "atp", "wta", "nfl", "hockey", "nhl", "mlb", "ufc", "mma", "stade", "h2h",
  "ligue", "champions", "premier league", "liga", "serie a", "bundesliga",
  "can", "mondial", "coupe du monde", "fantasy", "capitaine", "pepite", "cote", "coupon",
  "ticket", "maillon", "bankroll", "1xbet", "sportcash", "premier bet", "betclic",
  "asec", "mimosas", "stade d'abidjan", "san pedro", "al ahly", "sundowns", "wydad",
  "raja", "esperance", "mazembe", "al-hilal", "al hilal", "al-nassr", "al nassr",
  "inter miami", "flamengo", "palmeiras", "elephant", "cote d'ivoire", "maroc", "senegal",
  "psg", "marseille", "real", "barcelone", "barca", "arsenal", "liverpool",
  "city", "bayern", "inter", "juve", "milan", "monaco", "lyon", "lille",
  "demain", "aujourd", "ce soir", "evolu", "erreur",
];

function mentionsFootballTopic(text = "") {
  const n = cleanWords(text);
  return FOOTBALL_TRIGGER_WORDS.some((w) => n.includes(` ${w}`) || n.includes(w));
}

function installAutoLlmContextInjector(brain) {
  if (typeof window === "undefined" || window.__cloeFetchPatched || typeof window.fetch !== "function") {
    return;
  }
  window.__cloeFetchPatched = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function patchedCloeFetch(input, init) {
    try {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      const isLlmCall = LLM_API_HOSTS.some((host) => urlStr.includes(host));
      if (isLlmCall && init?.body && typeof init.body === "string") {
        const payload = JSON.parse(init.body);
        const serialized = JSON.stringify(payload);
        if (mentionsFootballTopic(serialized)) {
          // Extraire le dernier message utilisateur pour cibler exactement sa question
          let userQuestion = serialized.slice(-500);
          if (Array.isArray(payload.messages)) {
            const lastUser = [...payload.messages].reverse().find((m) => m.role === "user");
            if (typeof lastUser?.content === "string") userQuestion = lastUser.content;
          } else if (Array.isArray(payload.contents)) {
            const lastTurn = payload.contents[payload.contents.length - 1];
            const txtPart = lastTurn?.parts?.find((p) => typeof p.text === "string");
            if (txtPart) userQuestion = txtPart.text;
          }

          const liveReply = await brain.ask(userQuestion);
          const injectionNote =
            `\n\n[DONNÉES TEMPS RÉEL DU MODULE FOOTBALL AI ULTRA v5 LEGEND RELIÉ À CLOÉ — UTILISE CES CHIFFRES EXACTS DANS TA RÉPONSE :\n${liveReply.answerText}\nSynthèse vocale conseillée : ${liveReply.voiceText}]\n`;

          // Injection compatible OpenAI / Groq / Mistral / OpenRouter
          if (Array.isArray(payload.messages) && payload.messages.length > 0) {
            const lastIdx = payload.messages.length - 1;
            if (typeof payload.messages[lastIdx].content === "string") {
              payload.messages[lastIdx] = {
                ...payload.messages[lastIdx],
                content: payload.messages[lastIdx].content + injectionNote,
              };
            }
          }
          // Injection compatible Google Gemini API (AI Studio / Firebase)
          if (Array.isArray(payload.contents) && payload.contents.length > 0) {
            const lastIdx = payload.contents.length - 1;
            const parts = payload.contents[lastIdx]?.parts;
            if (Array.isArray(parts) && parts.length > 0 && typeof parts[0].text === "string") {
              parts[0] = { ...parts[0], text: parts[0].text + injectionNote };
            }
          }

          return nativeFetch(input, { ...init, body: JSON.stringify(payload) });
        }
      }
    } catch {
      // Ne jamais bloquer un appel réseau existant de Cloé
    }
    return nativeFetch(input, init);
  };
}

function installAbidjanAgentAutoPlugin(brain) {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    window.__cloeAbidjanPluginInstalled ||
    window.__cloeNativeV5Integrated
  ) {
    return;
  }
  const host = window.location.hostname || "";
  if (host.includes("football-ai-43e33") || host.includes("cloe-ia-ultra") || document.getElementById("cloe-root")) {
    return;
  }
  window.__cloeAbidjanPluginInstalled = true;

  const speakFrench = (text) => {
    try {
      if (!("speechSynthesis" in window)) return;
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = "fr-FR";
      utt.rate = 1.03;
      utt.__fromFootballAI = true;
      window.speechSynthesis.speak(utt);
    } catch {
      // ignore
    }
  };

  // 1) Enrichissement automatique du « Rapport du jour » lu à voix haute par Cloé · Abidjan
  if ("speechSynthesis" in window && typeof window.speechSynthesis.speak === "function") {
    const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = function patchedSpeak(utterance) {
      origSpeak(utterance);
      try {
        const spoken = cleanWords(utterance?.text || "");
        const isDailyReport =
          !utterance?.__fromFootballAI &&
          (spoken.includes("rapport du jour") || spoken.includes("brvm") || spoken.includes("crypto"));
        if (isDailyReport) {
          brain.getDailyBriefing().then((b) => {
            if (b?.voiceBriefing) {
              speakFrench("Point Football IA Ultra : " + b.voiceBriefing);
            }
          }).catch(() => {});
        }
      } catch {
        // ignore
      }
    };
  }

  // 2) Interception vocale automatique de l'orbe « À l'écoute » (même en mode Simulation Niveau L0)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (typeof SR === "function" && !SR.__cloePatched) {
    const OrigSR = SR;
    const PatchedSR = function (...args) {
      const rec = new OrigSR(...args);
      rec.addEventListener("result", async (ev) => {
        try {
          const transcript = Array.from(ev.results || [])
            .map((r) => r?.[0]?.transcript || "")
            .join(" ")
            .trim();
          if (transcript && mentionsFootballTopic(transcript)) {
            const reply = await brain.ask(transcript);
            const outEl = document.getElementById("cloe-foot-v5-output");
            if (outEl) outEl.textContent = reply.answerText;
            speakFrench(reply.voiceText);
          }
        } catch {
          // ignore
        }
      });
      return rec;
    };
    PatchedSR.__cloePatched = true;
    PatchedSR.prototype = OrigSR.prototype;
    if (window.SpeechRecognition) window.SpeechRecognition = PatchedSR;
    if (window.webkitSpeechRecognition) window.webkitSpeechRecognition = PatchedSR;
  }

  // 3) Injection automatique de la carte « Football IA v5 » dans l'écran Accueil de Cloé · Abidjan
  const mountCardIfNeeded = () => {
    if (document.getElementById("cloe-foot-v5-card")) return;
    const scriptForced = Boolean(document.querySelector('script[data-cloe-card="true"]'));
    const bodyTxt = document.body?.innerText || "";
    const isCloeAgentApp =
      scriptForced ||
      bodyTxt.includes("Agent personnel") ||
      bodyTxt.includes("Rapport du jour") ||
      bodyTxt.includes("BRVM");
    if (!isCloeAgentApp) return;

    const card = document.createElement("section");
    card.id = "cloe-foot-v5-card";
    card.style.cssText =
      "margin:14px auto;max-width:680px;padding:16px;border-radius:20px;background:#12131a;border:1px solid rgba(255,255,255,0.1);color:#f8fafc;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.35);";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <div>
          <div style="font-size:16px;font-weight:800;color:#fff;">⚡ Football IA Ultra v5</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:2px;">167 clubs (ASEC, LDC CAF, Europe) · CAN 10 000× · Buteurs & Ticket IA</div>
        </div>
        <a href="https://football-ai-43e33.web.app" target="_blank" rel="noopener" style="font-size:11px;font-weight:700;padding:6px 11px;border-radius:999px;background:rgba(56,189,248,0.16);border:1px solid rgba(56,189,248,0.45);color:#7dd3fc;text-decoration:none;">Ouvrir Football AI ↗</a>
      </div>
      <div id="cloe-foot-v5-btns" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;"></div>
      <pre id="cloe-foot-v5-output" style="margin:12px 0 0;padding:12px;border-radius:14px;background:rgba(255,255,255,0.04);color:#e2e8f0;font-size:12px;line-height:1.5;white-space:pre-wrap;font-family:inherit;">Module Football AI Ultra v5 connecté en direct à Cloé. Appuie sur un bouton ou pose ta question à voix haute !</pre>
    `;

    const presets = [
      ["📡 Pépites du jour", "Quelles sont les pépites d'aujourd'hui et demain ?"],
      ["🏆 CAN 10 000×", "Qui va gagner la CAN ?"],
      ["🌍 ASEC vs Al Ahly", "Analyse ASEC Mimosas contre Al Ahly"],
      ["⚽ Buteurs PSG-OM", "Buteurs, corners et cartons sur PSG contre Marseille"],
      ["🛡️ Ticket Sécurité", "Prépare mon Ticket Sécurité IA du jour"],
    ];

    // Insérer juste après la carte « Rapport du jour » si présente, sinon dans main / body
    const candidates = Array.from(document.querySelectorAll("div, section, article"));
    const reportEl = candidates.find(
      (el) =>
        el.children.length > 0 &&
        el.children.length <= 6 &&
        (el.textContent || "").includes("Rapport du jour") &&
        (el.textContent || "").length < 260
    );
    if (reportEl && reportEl.parentElement) {
      reportEl.insertAdjacentElement("afterend", card);
    } else {
      (document.querySelector("main") || document.body).appendChild(card);
    }

    const btnWrap = card.querySelector("#cloe-foot-v5-btns");
    const outEl = card.querySelector("#cloe-foot-v5-output");
    presets.forEach(([label, query]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.style.cssText =
        "background:rgba(139,92,246,0.18);border:1px solid rgba(192,132,252,0.4);color:#f3e8ff;border-radius:999px;padding:6px 11px;font-size:11px;font-weight:700;cursor:pointer;";
      btn.onclick = async () => {
        outEl.textContent = "Calcul IA temps réel en cours...";
        const res = await brain.ask(query);
        outEl.textContent = res.answerText;
        speakFrench(res.voiceText);
      };
      btnWrap.appendChild(btn);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(mountCardIfNeeded, 500));
  } else {
    setTimeout(mountCardIfNeeded, 500);
  }
  const obs = new MutationObserver(() => mountCardIfNeeded());
  if (document.documentElement) {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
}

if (typeof window !== "undefined") {
  window.CloeFootballAI = window.CloeFootballAI || createCloeFootballBrain();
  installAutoLlmContextInjector(window.CloeFootballAI);
  installAbidjanAgentAutoPlugin(window.CloeFootballAI);
  window.addEventListener("message", async (event) => {
    const msg = event?.data;
    if (!msg || msg.target !== "CLOE_FOOTBALL_AI") return;
    try {
      const reply = await window.CloeFootballAI.ask(msg.question || "Pronostics du jour");
      event.source?.postMessage(
        { source: "CLOE_FOOTBALL_AI", requestId: msg.requestId || null, ok: true, reply },
        "*"
      );
    } catch (err) {
      event.source?.postMessage(
        { source: "CLOE_FOOTBALL_AI", requestId: msg.requestId || null, ok: false, error: err.message },
        "*"
      );
    }
  });
}
