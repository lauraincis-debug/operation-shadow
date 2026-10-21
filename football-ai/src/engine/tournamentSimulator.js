import { computeFullPrediction } from "./predictor.js";

/**
 * 🏆 SIMULATEUR MONTE-CARLO 10 000× DE TOURNOI COMPLET
 * Simule intégralement Huitièmes -> Quarts -> Demies -> Finale -> Champion (avec Prolongations & Tirs au But)
 * pour la CAN, la Champions League et la Coupe du Monde !
 */

export const TOURNAMENT_PRESETS = {
  can: {
    id: "can",
    name: "🌍 Coupe d'Afrique des Nations (CAN — Phase Finale 16 Nations)",
    title: "🌍 Coupe d'Afrique des Nations (CAN — Phase Finale 16 Nations)",
    league: "international",
    roundOf16: [
      ["Côte d'Ivoire", "Mali"],
      ["Sénégal", "Guinée"],
      ["Maroc", "Afrique du Sud"],
      ["Nigeria", "Cameroun"],
      ["Égypte", "RD Congo"],
      ["Algérie", "Burkina Faso"],
      ["Tunisie", "Angola"],
      ["Ghana", "Gabon"],
    ],
  },
  ucl: {
    id: "ucl",
    name: "🇪🇺 UEFA Champions League (Phase Finale 16 Clubs)",
    title: "🇪🇺 UEFA Champions League (Phase Finale 16 Clubs)",
    league: "ucl",
    roundOf16: [
      ["PSG", "Bayern Munich"],
      ["Real Madrid", "Atlético Madrid"],
      ["Liverpool", "Inter Milan"],
      ["FC Barcelone", "Benfica"],
      ["Arsenal", "PSV Eindhoven"],
      ["Manchester City", "Bayer Leverkusen"],
      ["Borussia Dortmund", "Lille"],
      ["Aston Villa", "Sporting CP"],
    ],
  },
  worldcup: {
    id: "worldcup",
    name: "🌎 Coupe du Monde FIFA (Tableau Final Choc)",
    title: "🌎 Coupe du Monde FIFA (Tableau Final Choc)",
    league: "international",
    roundOf16: [
      ["France", "Belgique"],
      ["Espagne", "Italie"],
      ["Argentine", "Uruguay"],
      ["Brésil", "Colombie"],
      ["Angleterre", "Pays-Bas"],
      ["Portugal", "Maroc"],
      ["Allemagne", "Japon"],
      ["Côte d'Ivoire", "Sénégal"],
    ],
  },
};

function precomputePairWinProb(teamA, teamB, league, modelState, cache) {
  const key = `${teamA}__${teamB}`;
  if (cache.has(key)) return cache.get(key);

  const pred = computeFullPrediction(teamA, teamB, league, modelState, null, {
    neutralVenue: true,
  });
  // En match à élimination directe (90' + prolongations + TAB), le nul se départage 52/48 vers le plus haut Elo
  const pRegA = pred.probs[0] / 100;
  const pDraw = pred.probs[1] / 100;
  const eloBias = pred.elo.home >= pred.elo.away ? 0.525 : 0.475;
  const pAdvanceA = Math.min(0.94, Math.max(0.06, pRegA + pDraw * eloBias));
  const res = {
    pAdvanceA,
    mostLikelyScore: pred.topScores?.[0]?.score || "1 - 0",
    probs1X2: pred.probs,
  };
  cache.set(key, res);
  return res;
}

export function simulateKnockoutTournament(roundOf16Pairs, league = "international", modelState, runs = 10000) {
  const pairCache = new Map();
  const stats = {};
  const seenSlots = new Map();
  const sanitizedPairs = (roundOf16Pairs || []).map(([rawA, rawB]) => {
    const cleanSlot = (rawName, fallback) => {
      const base = String(rawName || fallback).trim() || fallback;
      const prevCount = seenSlots.get(base) || 0;
      seenSlots.set(base, prevCount + 1);
      return prevCount === 0 ? base : `${base} (#${prevCount + 1})`;
    };
    return [cleanSlot(rawA, "Équipe A"), cleanSlot(rawB, "Équipe B")];
  });

  for (const [a, b] of sanitizedPairs) {
    for (const t of [a, b]) {
      stats[t] = { team: t, qf: 0, sf: 0, final: 0, champion: 0 };
    }
  }

  // 1. Calculer le tableau déterministe "Parcours le plus probable IA" pour l'arbre visuel
  const deterministicBracket = {
    r16: [],
    qf: [],
    sf: [],
    final: null,
    mostLikelyChampion: "",
  };

  const qfTeamsDet = [];
  for (const [a, b] of sanitizedPairs) {
    const info = precomputePairWinProb(a, b, league, modelState, pairCache);
    const winner = info.pAdvanceA >= 0.5 ? a : b;
    deterministicBracket.r16.push({
      teamA: a,
      teamB: b,
      probA: Math.round(info.pAdvanceA * 100),
      probB: Math.round((1 - info.pAdvanceA) * 100),
      winner,
      scoreHint: info.mostLikelyScore,
    });
    qfTeamsDet.push(winner);
  }

  const sfTeamsDet = [];
  for (let i = 0; i < qfTeamsDet.length; i += 2) {
    const a = qfTeamsDet[i];
    const b = qfTeamsDet[i + 1];
    const info = precomputePairWinProb(a, b, league, modelState, pairCache);
    const winner = info.pAdvanceA >= 0.5 ? a : b;
    deterministicBracket.qf.push({
      teamA: a,
      teamB: b,
      probA: Math.round(info.pAdvanceA * 100),
      probB: Math.round((1 - info.pAdvanceA) * 100),
      winner,
    });
    sfTeamsDet.push(winner);
  }

  const finTeamsDet = [];
  for (let i = 0; i < sfTeamsDet.length; i += 2) {
    const a = sfTeamsDet[i];
    const b = sfTeamsDet[i + 1];
    const info = precomputePairWinProb(a, b, league, modelState, pairCache);
    const winner = info.pAdvanceA >= 0.5 ? a : b;
    deterministicBracket.sf.push({
      teamA: a,
      teamB: b,
      probA: Math.round(info.pAdvanceA * 100),
      probB: Math.round((1 - info.pAdvanceA) * 100),
      winner,
    });
    finTeamsDet.push(winner);
  }

  if (finTeamsDet.length === 2) {
    const [a, b] = finTeamsDet;
    const info = precomputePairWinProb(a, b, league, modelState, pairCache);
    const winner = info.pAdvanceA >= 0.5 ? a : b;
    deterministicBracket.final = {
      teamA: a,
      teamB: b,
      probA: Math.round(info.pAdvanceA * 100),
      probB: Math.round((1 - info.pAdvanceA) * 100),
      winner,
      scoreHint: info.mostLikelyScore,
    };
    deterministicBracket.mostLikelyChampion = winner;
  }

  // 2. Exécuter les 10 000 simulations Monte-Carlo complètes
  for (let r = 0; r < runs; r++) {
    // Huitièmes -> Quarts
    const qf = [];
    for (let i = 0; i < sanitizedPairs.length; i++) {
      const [a, b] = sanitizedPairs[i];
      const { pAdvanceA } = precomputePairWinProb(a, b, league, modelState, pairCache);
      const w = Math.random() < pAdvanceA ? a : b;
      stats[w].qf += 1;
      qf.push(w);
    }

    // Quarts -> Demies
    const sf = [];
    for (let i = 0; i < qf.length; i += 2) {
      const a = qf[i];
      const b = qf[i + 1];
      const { pAdvanceA } = precomputePairWinProb(a, b, league, modelState, pairCache);
      const w = Math.random() < pAdvanceA ? a : b;
      stats[w].sf += 1;
      sf.push(w);
    }

    // Demies -> Finale
    const fin = [];
    for (let i = 0; i < sf.length; i += 2) {
      const a = sf[i];
      const b = sf[i + 1];
      const { pAdvanceA } = precomputePairWinProb(a, b, league, modelState, pairCache);
      const w = Math.random() < pAdvanceA ? a : b;
      stats[w].final += 1;
      fin.push(w);
    }

    // Finale -> Champion !
    if (fin.length === 2) {
      const { pAdvanceA } = precomputePairWinProb(fin[0], fin[1], league, modelState, pairCache);
      const champ = Math.random() < pAdvanceA ? fin[0] : fin[1];
      stats[champ].champion += 1;
    }
  }

  const leaderboard = Object.values(stats)
    .map((s) => ({
      team: s.team,
      qfPct: Math.round((s.qf / runs) * 1000) / 10,
      sfPct: Math.round((s.sf / runs) * 1000) / 10,
      finalPct: Math.round((s.final / runs) * 1000) / 10,
      championPct: Math.round((s.champion / runs) * 1000) / 10,
      fairOutrightOdd: Math.max(
        1.25,
        Math.round((runs / Math.max(25, s.champion)) * 100) / 100
      ),
    }))
    .sort((a, b) => b.championPct - a.championPct);

  return {
    runs,
    leaderboard,
    bracket: deterministicBracket,
  };
}
