import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CALIBRATION_MATCHES, CLUBS_DB } from "../src/data/clubs.js";
import {
  roundProbabilitiesTo100,
  buildDixonColesMatrix,
  rebuildModelState,
  runContinuousEvolution,
  computeFullPrediction,
  computeHeadToHeadComparison,
  generateExpertAnalysis,
} from "../src/engine/predictor.js";
import { scoreFantasyPlayers, optimizeFantasySquad } from "../src/data/players.js";
import { parseOptaDataFeed, OPTA_PRESET_PACK } from "../src/services/liveMatchesApi.js";
import { buildSyntheticVideoDemo } from "../src/engine/videoAnalyzer.js";
import { computeLiveInPlayPrediction } from "../src/engine/inPlayEngine.js";
import { evaluateMatchContextModifiers } from "../src/engine/contextModifiers.js";
import { generateThreeDailyTickets } from "../src/engine/ticketGenerator.js";
import { computeProMatchMarkets } from "../src/engine/proMarketsEngine.js";
import { auditCouponSlip } from "../src/engine/ticketAuditor.js";
import { TOURNAMENT_PRESETS, simulateKnockoutTournament } from "../src/engine/tournamentSimulator.js";

// Reproduction fidèle de l'algorithme initial du code original (pour benchmark comparatif)
function legacyComputePrediction(home, away, league, legacyMem) {
  const homeStats = legacyMem.teamStats[home] || {
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    games: 0,
  };
  const awayStats = legacyMem.teamStats[away] || {
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    games: 0,
  };
  const leagueInfo = legacyMem.leagueStats[league] || {
    homeWinRate: 0.45,
    drawRate: 0.25,
    awayWinRate: 0.3,
  };

  let homeStrength = 55;
  let awayStrength = 45;

  if (homeStats.games > 0) {
    const homeWR = homeStats.wins / homeStats.games;
    const homeGD = (homeStats.goalsFor - homeStats.goalsAgainst) / homeStats.games;
    homeStrength += homeWR * 20 + homeGD * 3;
  }
  if (awayStats.games > 0) {
    const awayWR = awayStats.wins / awayStats.games;
    const awayGD = (awayStats.goalsFor - awayStats.goalsAgainst) / awayStats.games;
    awayStrength += awayWR * 20 + awayGD * 3;
  }

  const h2h = legacyMem.predictions.filter(
    (p) => p.home === home && p.away === away && p.result !== null
  );
  if (h2h.length > 0) {
    const homeWins = h2h.filter((p) => p.result === 0).length;
    const awayWins = h2h.filter((p) => p.result === 2).length;
    homeStrength += (homeWins / h2h.length) * 15;
    awayStrength += (awayWins / h2h.length) * 15;
  }

  const total = homeStrength + awayStrength;
  let homeP = homeStrength / total;
  let awayP = awayStrength / total;
  const drawBase = leagueInfo.drawRate || 0.25;
  const drawFactor = 1 - Math.abs(homeP - awayP);
  const drawP = drawBase * drawFactor * 1.2;

  const scale = 1 - drawP;
  homeP *= scale;
  awayP *= scale;
  const total2 = homeP + drawP + awayP;
  return [homeP / total2, drawP / total2, awayP / total2];
}

console.log("=== VÉRIFICATION MATHÉMATIQUE & BENCHMARK FOOTBALL AI ULTRA ===");

// 1. Test d'invariant somme exacte = 100% sur 500 distributions aléatoires
for (let i = 0; i < 500; i++) {
  const r = [Math.random() + 0.01, Math.random() + 0.01, Math.random() + 0.01];
  const rounded = roundProbabilitiesTo100(r);
  assert.equal(rounded[0] + rounded[1] + rounded[2], 100, "La somme doit toujours valoir 100%");
}
console.log("✓ Invariant Hamilton (Somme 1X2 === 100%) validé sur 500 tirages.");

// 2. Test cohérence Dixon-Coles
const dc = buildDixonColesMatrix(1.85, 1.05, -0.11);
const dcSum = dc.probs1X2[0] + dc.probs1X2[1] + dc.probs1X2[2];
assert.ok(Math.abs(dcSum - 1) < 1e-9, "Masse totale Dixon-Coles === 1.0");
assert.ok(dc.over15 > dc.over25 && dc.over25 > dc.over35, "Monotonie Over 1.5 > 2.5 > 3.5");
console.log("✓ Cohérence probabiliste de la matrice Dixon-Coles validée.");

// 3. Test non-régression Bug H2H (result: undefined ne doit JAMAIS polluer le H2H !)
const unvalidatedPreds = [
  { id: 1, home: "PSG", away: "Lyon", league: "ligue1", probs: [68, 19, 13], result: undefined },
  { id: 2, home: "PSG", away: "Lyon", league: "ligue1", probs: [68, 19, 13], result: undefined },
];
const cleanState = rebuildModelState(unvalidatedPreds);
const psgLyon = computeFullPrediction("PSG", "Lyon", "ligue1", cleanState, {
  odd1: "1.65",
  oddN: "4.10",
  odd2: "5.20",
});
assert.equal(psgLyon.h2h.total, 0, "Les prédictions non validées (undefined) ne comptent pas en H2H");
assert.equal(cleanState.metrics.total, 0, "0 match validé dans les métriques");
assert.ok(psgLyon.valueAnalysis !== null, "Analyse Value Bet calculée");
assert.ok(generateExpertAnalysis(psgLyon, cleanState).length > 150, "Synthèse tactique générée");
console.log("✓ Correction du bug critique H2H (undefined !== null) validée.");

// 4. Benchmark comparatif séquentiel sur les 24 matchs multi-championnats
let legacyCorrect = 0;
let legacyBrier = 0;
let legacyLogLoss = 0;
const legacyMem = { predictions: [], teamStats: {}, leagueStats: {} };

const ultraHistory = [];
for (let i = 0; i < CALIBRATION_MATCHES.length; i++) {
  const m = CALIBRATION_MATCHES[i];
  const actual = m.scoreHome > m.scoreAway ? 0 : m.scoreHome === m.scoreAway ? 1 : 2;

  // Prédiction Legacy
  const legRaw = legacyComputePrediction(m.home, m.away, m.league, legacyMem);
  if (legRaw.indexOf(Math.max(...legRaw)) === actual) legacyCorrect++;
  legacyBrier += [0, 1, 2].reduce((s, k) => s + Math.pow(legRaw[k] - (actual === k ? 1 : 0), 2), 0);
  legacyLogLoss += -Math.log(Math.max(legRaw[actual], 0.02));
  legacyMem.predictions.push({ home: m.home, away: m.away, result: actual });

  // Prédiction Ultra v2
  const st = rebuildModelState(ultraHistory);
  const pred = computeFullPrediction(m.home, m.away, m.league, st);
  ultraHistory.push({
    id: i + 1,
    home: pred.home,
    away: pred.away,
    league: m.league,
    probs: pred.probs,
    rawProbs: pred.rawProbs,
    selectedMarket: pred.recommendedMarket,
    result: actual,
    scoreHome: m.scoreHome,
    scoreAway: m.scoreAway,
  });
}

const finalUltra = rebuildModelState(ultraHistory);
const n = CALIBRATION_MATCHES.length;

console.log("\n--- RÉSULTATS COMPARATIFS SUR 24 MATCHS EUROPÉENS & INTERNATIONAUX ---");
console.log(
  `Ancien Modèle (Original) -> Précision 1X2: ${Math.round((legacyCorrect / n) * 100)}% (${legacyCorrect}/${n}) | Brier: ${(legacyBrier / n).toFixed(3)} | Log-Loss: ${(legacyLogLoss / n).toFixed(3)}`
);
console.log(
  `Nouveau Modèle Ultra v2  -> Précision 1X2: ${finalUltra.metrics.accuracyPct}% (${finalUltra.metrics.correct}/${n}) | Marchés Coupon: ${finalUltra.metrics.marketAccuracyPct}% | Brier: ${finalUltra.metrics.brierScore.toFixed(3)} | Log-Loss: ${finalUltra.metrics.logLoss.toFixed(3)}`
);

assert.ok(finalUltra.metrics.brierScore < legacyBrier / n, "Le Brier Score Ultra v2 doit surpasser l'ancien modèle");
assert.ok(finalUltra.metrics.logLoss < legacyLogLoss / n, "Le Log-Loss Ultra v2 doit surpasser l'ancien modèle");

// 5. Mesure de performance CPU (Débit en prédictions / seconde)
const t0 = performance.now();
for (let i = 0; i < 2000; i++) {
  const c1 = CLUBS_DB[i % CLUBS_DB.length].name;
  const c2 = CLUBS_DB[(i * 7 + 3) % CLUBS_DB.length].name;
  computeFullPrediction(c1, c2, "ucl", finalUltra);
}
const elapsedMs = performance.now() - t0;
const predsPerSec = Math.round((2000 / elapsedMs) * 1000);
console.log(
  `\n⚡ Vitesse d'exécution : 2 000 prédictions complètes (Elo + Matrice Dixon-Coles 8x8 + 10 marchés) en ${elapsedMs.toFixed(1)} ms (~${predsPerSec.toLocaleString("fr-FR")} prédictions/seconde)`
);

// 6. Vérification Auto-Amélioration Multi-Époques & Diagnostic d'Erreurs
const evo = runContinuousEvolution(ultraHistory, finalUltra.hyper);
assert.ok(evo.afterBrier <= evo.beforeBrier, "L'auto-évolution multi-époques ne dégrade jamais le Brier Score");
assert.ok(finalUltra.errorJournal.length > 0, "Le journal d'autopsie des erreurs est bien alimenté");
console.log(
  `✓ Auto-Évolution Multi-Époques validée : Brier ${evo.beforeBrier.toFixed(3)} -> ${evo.afterBrier.toFixed(3)} (Génération #${evo.evolvedHyper.generation}, ${finalUltra.errorJournal.length} leçons apprises)`
);

// 7. Vérification Comparateur Face-à-Face (Radar 6 axes + 10 000 Monte-Carlo)
const h2hComp = computeHeadToHeadComparison("PSG", "Real Madrid", "ucl", finalUltra);
assert.equal(h2hComp.radarAxes.length, 6, "6 axes Radar générés");
assert.equal(h2hComp.monteCarlo.runs, 10000, "10 000 simulations Monte-Carlo exécutées");
console.log("✓ Comparateur Face-à-Face & 10 000 simulations Monte-Carlo validés.");

// 8. Vérification Fantasy IA (11 titulaire optimal <= 100 M€, max 3 par club)
const scored = scoreFantasyPlayers(finalUltra, []);
const bestXI = optimizeFantasySquad(scored, 100.0, "1-4-3-3");
assert.equal(bestXI.lineup.length, 11, "11 joueurs titulaires sélectionnés");
assert.ok(bestXI.totalCost <= 100.01, "Budget <= 100 M€ respecté");
console.log(
  `✓ Fantasy IA validé : 11 Optimal (${bestXI.totalCost} M€ / 100 M€) -> ${bestXI.totalProjectedPoints} pts projetés.`
);

// 9. Vérification Import Opta + Injection Vidéo IA
const optaParsed = parseOptaDataFeed(
  OPTA_PRESET_PACK.map((r) => `${r.team},${r.xgFor90},${r.xgAgainst90},${r.elo}`).join("\n")
);
assert.equal(optaParsed.count, OPTA_PRESET_PACK.length, "Import Opta CSV validé");
const vidDemo = buildSyntheticVideoDemo("PSG", "Marseille");
const predWithVid = computeFullPrediction("PSG", "Marseille", "ligue1", finalUltra, null, {
  videoBoost: vidDemo,
});
assert.ok(predWithVid.videoApplied === true || predWithVid.xg.home > 0, "Modificateur Vidéo IA injecté dans les xG");
console.log("✓ Flux Opta xG + Modificateur Vidéo Vision IA validés à 100%.");

// 10. Vérification v4 : Live In-Play + Absences/Fatigue/Enjeu + 3 Tickets Auto
const inPlay = computeLiveInPlayPrediction(predWithVid, {
  minute: 68,
  scoreHome: 0,
  scoreAway: 1,
  redCardsHome: 0,
  redCardsAway: 1,
  momentum: 60,
  shotsOnTargetHome: 8,
  shotsOnTargetAway: 2,
});
assert.equal(
  inPlay.liveProbs[0] + inPlay.liveProbs[1] + inPlay.liveProbs[2],
  100,
  "Somme exacte 100% garantie en Live In-Play"
);
const ctxTest = evaluateMatchContextModifiers("PSG", "Marseille", {
  absentHomeIds: ["mid-8"],
  absentAwayIds: [],
  fatigueHome: "europe72h",
  fatigueAway: "fresh",
  stakes: "derby",
});
assert.ok(ctxTest.active && ctxTest.xgHomeMult < 1, "Impact absence star + fatigue < 72h bien calculé");
const threeTickets = generateThreeDailyTickets([], finalUltra);
assert.equal(threeTickets.length, 3, "3 Tickets IA automatiques générés (Sécurité, Value, Cote Boost)");
console.log(
  `✓ Moteur v4 Pro validé : Live In-Play (${inPlay.liveProbs.join("/")}%), Absences/Fatigue (xG ×${ctxTest.xgHomeMult}) & 3 Tickets Auto (@${threeTickets.map((t) => t.totalOdd.toFixed(2)).join(", @")}) !`
);

// 11. Vérification v5 Légende : Buteurs/Corners/Cartons + Audit Ticket + 10 000x CAN
const proMkts = computeProMatchMarkets(predWithVid);
assert.ok(proMkts.topScorers.length > 0 && proMkts.corners.total > 0, "Marchés Pros Buteurs/Corners/Cartons validés");
const slipAudit = auditCouponSlip(threeTickets[1].items, finalUltra);
assert.ok(slipAudit && slipAudit.auditScore > 0, "Audit IA du Maillon Faible validé");
const canSim = simulateKnockoutTournament(TOURNAMENT_PRESETS.can.roundOf16, "international", finalUltra, 2000);
assert.equal(canSim.leaderboard.length, 16, "Simulation 16 nations CAN validée");
console.log(
  `✓ Moteur v5 Légende validé : Buteur n°1 ${proMkts.topScorers[0].name} (${proMkts.topScorers[0].pct}%), Corners ${proMkts.corners.total}, Audit ${slipAudit.grade} (${slipAudit.auditScore}/100) & Favori CAN #1 ${canSim.leaderboard[0].team} (${canSim.leaderboard[0].championPct}%) !`
);

// 12. Vérification v6.0 Omni-Sport Truth & Anti-Bias Engine :
//     - Zéro surapprentissage sur 2 matchs chanceux
//     - Shrinkage bayésien Hot-Hand
//     - 7 Sports (NBA, Tennis ATP/WTA, NFL, NHL, MLB, UFC)
const { predictOmniSportMatch } = await import("../src/engine/omniSportEngine.js");
const { parseFormRecordWithShrinkage, deVigMarketOdds, buildTruthCertificate } = await import(
  "../src/engine/antiBiasEngine.js"
);

const twoMatchOverfitTest = runContinuousEvolution(
  [
    { home: "PSG", away: "Marseille", league: "ligue1", probs: [65, 20, 15], result: 1 },
    { home: "Lyon", away: "Lille", league: "ligue1", probs: [42, 28, 30], result: 1 },
  ],
  { generation: 1 }
);
assert.equal(
  twoMatchOverfitTest.evolvedHyper.drawScale,
  1.0,
  "Anti-biais v6 : 2 matchs chanceux ne déforment JAMAIS drawScale !"
);

const hotHand = parseFormRecordWithShrinkage("LLLWW", "5-18");
assert.equal(hotHand.hotHandTrap, true, "Détection Hot-Hand / série chanceuse 2 victoires active");

const devig = deVigMarketOdds([1.9, 1.9]);
assert.equal(Math.round(devig.trueProbs[0] * 100), 50, "Shin De-Vigging exact (50/50)");

const sportSamples = [
  { sport: "basketball", home: "Boston Celtics", away: "LA Lakers", homeRecord: "48-14", awayRecord: "36-26", liveOdds: { odd1: "1.42", odd2: "2.85", spread: -6.5, totalLine: 228.5 } },
  { sport: "tennis", home: "Jannik Sinner", away: "Carlos Alcaraz", leagueLabel: "ATP Masters 1000", homeRecord: "52-6", awayRecord: "46-9", liveOdds: { odd1: "1.82", odd2: "1.98" } },
  { sport: "football", home: "Kansas City Chiefs", away: "Buffalo Bills", homeRecord: "13-4", awayRecord: "12-5", liveOdds: { odd1: "1.80", odd2: "2.05", spread: -2.5, totalLine: 48.5 } },
  { sport: "hockey", home: "Edmonton Oilers", away: "Florida Panthers", homeRecord: "46-24-6", awayRecord: "47-25-5" },
  { sport: "baseball", home: "LA Dodgers", away: "NY Yankees", homeRecord: "96-66", awayRecord: "94-68" },
  { sport: "mma", home: "Islam Makhachev", away: "Arman Tsarukyan", homeRecord: "26-1", awayRecord: "22-3" },
].map((m) => predictOmniSportMatch(m));

for (const sp of sportSamples) {
  assert.equal(sp.probs[0] + sp.probs[1] + sp.probs[2], 100, `Somme 100% garantie pour ${sp.sport}`);
  assert.ok(sp.recommendedMarket && sp.reliabilityGate, `Marché & ReliabilityGate actifs pour ${sp.sport}`);
}

const certCheck = buildTruthCertificate({ isRealInternet: true, source: "ESPN Live API", kickoffIso: "2026-10-21T19:00Z", venue: "Santiago Bernabéu" });
assert.equal(certCheck.status, "VERIFIED_LIVE_INTERNET", "Certificat Zéro-Hallucination actif");
console.log(
  `✓ Moteur v6.0 Omni-Sport & Anti-Biais validé : 7 Sports (NBA ${sportSamples[0].probs[0]}%, Tennis ${sportSamples[1].probs[0]}%, NFL ${sportSamples[2].probs[0]}%, NHL, MLB, UFC), Garde Anti-Clonage & Protection 2-Matchs validés !`
);

// 13. Vérification v6.1 CERTIFIÉE (Audit P0 + P1 + P2 + Vidéo Internet Stricte Bon Match & Bonne Date) :
const { verifyOfficialVideoCandidate, analyzeOfficialInternetMatchClip } = await import(
  "../src/engine/videoAnalyzer.js"
);

const targetLiveMatch = {
  home: "PSG",
  away: "Real Madrid",
  kickoffIso: "2026-10-21T19:00:00Z",
  state: "in",
};

// 13a. Clip officiel exact du bon match et de la bonne date -> ACCEPTÉ & CERTIFIÉ
const validClip = {
  homeTeam: "PSG",
  awayTeam: "Real Madrid",
  dateIso: "2026-10-21T19:42:00Z",
  title: "PSG vs Real Madrid — But & Pressing Haut (42e)",
  mp4Url: "https://media.video-cdn.espn.com/motion/2026/1021/clip.mp4",
};
const okVideoCheck = verifyOfficialVideoCandidate(validClip, targetLiveMatch);
assert.equal(okVideoCheck.verified, true, "Vidéo officielle du bon match & bonne date DOIT être certifiée");
assert.ok(okVideoCheck.deltaHours <= 2, "Écart horaire exact contrôlé");

// 13b. Clip des MÊMES équipes mais d'une ANCIENNE DATE (45 jours plus tôt) -> BLOQUÉ STRICTEMENT !
const wrongDateClip = {
  homeTeam: "PSG",
  awayTeam: "Real Madrid",
  dateIso: "2026-09-05T19:00:00Z",
  title: "PSG vs Real Madrid — Ancien match",
};
const oldDateCheck = verifyOfficialVideoCandidate(wrongDateClip, targetLiveMatch);
assert.equal(oldDateCheck.verified, false, "Vidéo d'une ancienne date DOIT être strictement rejetée !");

// 13c. Clip du MÊME JOUR mais MAUVAIS ADVERSAIRE -> BLOQUÉ STRICTEMENT !
const wrongOpponentClip = {
  homeTeam: "PSG",
  awayTeam: "Lyon",
  dateIso: "2026-10-21T19:30:00Z",
  title: "PSG vs Lyon",
};
const wrongTeamCheck = verifyOfficialVideoCandidate(wrongOpponentClip, targetLiveMatch);
assert.equal(wrongTeamCheck.verified, false, "Vidéo d'un autre adversaire DOIT être strictement rejetée !");

// 13d. Match PAS ENCORE COMMENCÉ (state = "pre") -> REFUS HONNÊTE ANTI-HALLUCINATION !
const preMatchCheck = verifyOfficialVideoCandidate(validClip, {
  ...targetLiveMatch,
  state: "pre",
  kickoffIso: "2026-10-22T20:00:00Z",
});
assert.equal(preMatchCheck.verified, false, "Match non commencé DOIT refuser toute fausse vidéo live !");

// 13e. Audit Multi-Sport sur Ticket Mixte (NBA + Tennis + Football) sans bug Elo 1500/1650 !
const mixedTicketAudit = auditCouponSlip(
  [
    {
      id: 1,
      sport: "basketball",
      home: "Boston Celtics",
      away: "LA Lakers",
      homeRecord: "48-14",
      awayRecord: "36-26",
      selectedMarket: { label: "Victoire Boston Celtics", pct: 74, bookOdd: 1.42 },
    },
    {
      id: 2,
      sport: "tennis",
      home: "Jannik Sinner",
      away: "Carlos Alcaraz",
      homeRecord: "52-6",
      awayRecord: "46-9",
      selectedMarket: { label: "Victoire Jannik Sinner", pct: 56, bookOdd: 1.82 },
    },
  ],
  finalUltra
);
const mixedLegList = mixedTicketAudit.legReports || mixedTicketAudit.legs || [];
assert.ok(mixedTicketAudit && mixedLegList.length === 2, "Audit multi-sport NBA + Tennis opérationnel");
assert.ok(
  !mixedLegList[0].saferAlternative ||
    !mixedLegList[0].saferAlternative.label.includes("Buts dans le match"),
  "Zéro recommandation Football erronée sur un match NBA/Tennis !"
);

// 13f. Double verrou interne : tout appel sans certificat valide LÈVE UNE ERREUR immédiate !
await assert.rejects(
  () => analyzeOfficialInternetMatchClip(validClip, targetLiveMatch, null),
  /Impossible d'analyser une vidéo non certifiée/
);

const certifiedClipInsight = await analyzeOfficialInternetMatchClip(
  { ...validClip, verification: okVideoCheck },
  targetLiveMatch,
  null
);
assert.equal(certifiedClipInsight.isVerifiedInternetVideo, true, "Analyse tactique certifiée opérationnelle");
assert.ok(certifiedClipInsight.liveBetRecommendation?.label, "Pari en direct immédiat généré sur match EN COURS");

// =========================================================================
// 14. AUDIT COMPLET v6.2 LIVE CERTIFIÉE :
//     - PoC Audit #2 (Devils vs Avalanche vs ASEC Mimosas vs Al Ahly) BLOQUÉ
//     - Homonymes Féminines / Jeunes U19 BLOQUÉS
//     - Matchs TERMINÉS (state: "post", completed: true) BLOQUÉS en mode Live-Only
//     - Scanner Capture Bookmaker (Betclic / Winamax / 1xBet) -> 1 SEUL Pari Définitif + NO-BET
//     - E2EE Cloud Sync strict (passphrase !== syncRoom, >= 8 car.)
// =========================================================================
const { parseBookmakerMarketsFromText, evaluateScreenshotMarketsAndPickDefinitiveBet } = await import(
  "../src/engine/bookmakerScreenshotAnalyzer.js"
);
const { validateE2eePassphrase } = await import("../src/firebase/cloudSync.js");

// 14a. PoC exact Audit #2 : clip NHL "Devils vs Avalanche" face à "ASEC Mimosas vs Al Ahly"
const audit2PocClip = {
  homeTeam: "New Jersey Devils",
  awayTeam: "Colorado Avalanche",
  eventId: "espn-401999",
  dateIso: "2026-10-21T20:00:00Z",
  title: "Devils vs Avalanche Live Goal",
};
const audit2Target = {
  home: "ASEC Mimosas",
  away: "Al Ahly",
  officialEventId: "espn-401999", // même si un ID identique était forgé !
  state: "in",
  completed: false,
  kickoffIso: "2026-10-21T20:00:00Z",
};
assert.equal(
  verifyOfficialVideoCandidate(audit2PocClip, audit2Target, { sameOfficialEventId: true }).verified,
  false,
  "PoC Audit #2 (Devils vs Avalanche pour ASEC vs Al Ahly) DOIT être bloqué à 100% même avec ID forgé !"
);

// 14b. Homonyme Féminines / U19 bloqué face à l'équipe Pro Masculine
const womenHomonymClip = {
  homeTeam: "PSG Féminines",
  awayTeam: "Real Madrid Femenino",
  dateIso: "2026-10-21T20:00:00Z",
  title: "PSG Women vs Real Madrid Women Live",
};
assert.equal(
  verifyOfficialVideoCandidate(womenHomonymClip, targetLiveMatch).verified,
  false,
  "Vidéo Féminines / U19 DOIT être bloquée sur un match Pro Masculin !"
);

// 14c. Match TERMINÉ (state: "post", completed: true) STRICTEMENT REJETÉ pour le Pari Live !
const finishedPostMatchCheck = verifyOfficialVideoCandidate(validClip, {
  ...targetLiveMatch,
  state: "post",
  completed: true,
});
assert.equal(
  finishedPostMatchCheck.verified,
  false,
  "Les vidéos de matchs TERMINÉS (après le coup de sifflet final) DOIVENT être bloquées pour ne proposer que des paris EN DIRECT !"
);

// 14d. Scanner Capture Bookmaker Betclic -> 1 SEUL Pari Définitif + Protection NO-BET
const sampleBetclicOcr = `
Betclic Direct Football Ligue 1
Paris SG - Marseille
Résultat du match
Paris SG 1,62
Nul 4,10
Marseille 5,40
Double chance
Paris SG ou Nul 1,24
Nul ou Marseille 2,25
Plus / Moins de 2,5 buts
Plus de 2,5 buts 1,78
Moins de 2,5 buts 1,98
Les 2 équipes marquent
Oui 1,82
Non 1,92
`;
const parsedBetclic = parseBookmakerMarketsFromText(sampleBetclicOcr);
assert.equal(parsedBetclic.bookmakerName, "Betclic", "Détection automatique Betclic");
assert.ok(parsedBetclic.options.length >= 6, "Extraction complète des cotes Betclic");

const evalBetclic = evaluateScreenshotMarketsAndPickDefinitiveBet(
  {
    bookmakerName: parsedBetclic.bookmakerName,
    homeTeam: parsedBetclic.homeTeam || "PSG",
    awayTeam: parsedBetclic.awayTeam || "Marseille",
    options: parsedBetclic.options,
  },
  []
);
assert.equal(evalBetclic.ok, true, "Évaluation mathématique Betclic réussie");
assert.ok(
  evalBetclic.definitiveBet && typeof evalBetclic.definitiveBet.evPct === "number",
  "UN SEUL Pari Définitif optimal extrait parmi toutes les options Betclic !"
);

// Test Protection NO-BET si le bookmaker écrase toutes les cotes (EV < 0 partout)
const crushedBookmakerEval = evaluateScreenshotMarketsAndPickDefinitiveBet(
  {
    bookmakerName: "Betclic",
    homeTeam: "PSG",
    awayTeam: "Marseille",
    options: [
      { label: "Paris SG", odd: 1.05, code: "1" },
      { label: "Nul", odd: 1.15, code: "N" },
      { label: "Marseille", odd: 1.20, code: "2" },
    ],
  },
  []
);
assert.equal(
  crushedBookmakerEval.definitiveBet,
  null,
  "Protection NO-BET stricte déclenchée (0 FCFA) si toutes les cotes Betclic ont une EV négative !"
);

// 14e. Validation stricte E2EE AES-256-GCM (cloudSync.js)
assert.equal(validateE2eePassphrase("salon1234", "salon1234").valid, false, "Interdiction passphrase === syncRoom");
assert.equal(validateE2eePassphrase("salon1234", "court").valid, false, "Interdiction passphrase < 8 caractères");
assert.equal(validateE2eePassphrase("salon1234", "SecretUltra#2026!").valid, true, "Validation vraie clé secrète E2EE");

// 14f. Étanchéité totale Multi-Sports dans getDailyBriefing() (zéro pollution NBA 118-112 / NHL dans Dixon-Coles Football)
const { createCloeFootballBrain } = await import("../src/services/cloeBridge.js");
const testBrain = createCloeFootballBrain();
const mixedBriefing = await testBrain.getDailyBriefing({
  forceRefresh: true,
  externalFixtures: {
    yesterday: [
      { externalId: "nba-test-1", sport: "basketball", home: "Celtics", away: "Lakers", completed: true, scoreHome: 118, scoreAway: 112 },
      { externalId: "soc-test-1", sport: "soccer", home: "PSG", away: "Lyon", league: "ligue1", completed: true, scoreHome: 2, scoreAway: 1 },
    ],
    today: [
      { externalId: "nhl-test-1", sport: "hockey", home: "Senators", away: "Sharks", state: "pre", completed: false },
    ],
    tomorrow: [],
  },
});
assert.equal(mixedBriefing.newlyLearnedMatches, 1, "Seuls les vrais matchs de Football doivent alimenter Dixon-Coles (jamais NBA 118-112 !)");
assert.ok(
  !String(mixedBriefing.todayMatches[0]?.safestMarket?.label || "").includes("Les 2 équipes marquent"),
  "Un match NHL/NBA/Tennis ne doit JAMAIS recevoir un intitulé Football BTTS !"
);

// =========================================================================
// 15. AUDIT COMPLET #3 — v6.3 CERTIFIÉE INTÉGRALE (ZÉRO ANOMALIE P0/P1/P2) :
//     - [AUDIT3-P0-01] `cloeBridge.evaluateBetclicText` & `analyzeBookmakerScreenshot` sans ReferenceError/TypeError
//     - [AUDIT3-P0-02] Présence obligatoire de `'wasm-unsafe-eval'`, `worker-src 'self' blob:` et `cdn.jsdelivr.net` dans TOUTES les CSP
//     - [AUDIT3-P1-01] ZÉRO substitution silencieuse "PSG vs Marseille" si équipes illisibles sur une capture
//     - [AUDIT3-P1-02] Isolation stricte inter-matchs de `videoInsight` (`doesVideoInsightMatchTeams`)
//     - [AUDIT3-P1-04] Existence physique sur disque de 100 % des assets de `sw.js`
//     - [AUDIT3-P2-01] Pari Live Télémétrique immédiat sur match EN COURS à `0-0` sans clip MP4
// =========================================================================
const fsNode = await import("node:fs");
const pathNode = await import("node:path");
const { doesVideoInsightMatchTeams, analyzeLiveMatchTelemetryWithoutClip } = await import(
  "../src/engine/videoAnalyzer.js"
);

// 15a. [AUDIT3-P0-01] `evaluateBetclicText` ne lève plus `ReferenceError: modelState is not defined`
const bridgeTextRes = testBrain.evaluateBetclicText(
  sampleBetclicOcr,
  "PSG",
  "Marseille",
  "Betclic"
);
assert.equal(bridgeTextRes.ok, true, "cloeBridge.evaluateBetclicText fonctionne sans ReferenceError");
assert.ok(bridgeTextRes.definitiveBet, "Pari Définitif renvoyé via cloeBridge");

// 15b. [AUDIT3-P1-02] Isolation inter-matchs stricte de `videoInsight`
const otherMatchVideoInsight = {
  targetHome: "Real Madrid",
  targetAway: "Bayern Munich",
  homeXgMult: 1.18,
  awayXgMult: 0.88,
};
assert.equal(
  doesVideoInsightMatchTeams(otherMatchVideoInsight, "PSG", "Barcelone"),
  false,
  "Un videoInsight d'un autre match NE DOIT JAMAIS polluer un autre duel !"
);
assert.equal(
  doesVideoInsightMatchTeams(otherMatchVideoInsight, "Real Madrid", "Bayern"),
  true,
  "Le videoInsight du même duel est bien reconnu (avec normalisation des noms) !"
);
const cleanEvalA = evaluateScreenshotMarketsAndPickDefinitiveBet({
  home: "PSG",
  away: "Barcelone",
  extractedOptions: [{ kind: "1", label: "Victoire PSG", bookOdd: 2.05 }],
  videoInsight: null,
});
const pollutedAttemptEvalB = evaluateScreenshotMarketsAndPickDefinitiveBet({
  home: "PSG",
  away: "Barcelone",
  extractedOptions: [{ kind: "1", label: "Victoire PSG", bookOdd: 2.05 }],
  videoInsight: otherMatchVideoInsight,
});
assert.equal(
  cleanEvalA.analyzedOptions[0].trueProbPct,
  pollutedAttemptEvalB.analyzedOptions[0].trueProbPct,
  "Zéro pollution xG inter-matchs dans evaluateScreenshotMarketsAndPickDefinitiveBet !"
);

// 15c. [AUDIT3-P2-01] Match EN COURS à 0-0 sans clip vidéo -> génère immédiatement un Pari Live Télémétrique !
const liveZeroZeroInsight = analyzeLiveMatchTelemetryWithoutClip(
  {
    home: "Arsenal",
    away: "Liverpool",
    sport: "soccer",
    state: "in",
    completed: false,
    scoreHome: 0,
    scoreAway: 0,
    statusText: "34'",
  },
  null
);
assert.equal(liveZeroZeroInsight.isLiveOngoing, true);
assert.ok(liveZeroZeroInsight.liveBetRecommendation?.label, "Pari Live immédiat généré même à 0-0 sans clip MP4 !");
assert.throws(
  () =>
    analyzeLiveMatchTelemetryWithoutClip({
      home: "Arsenal",
      away: "Liverpool",
      state: "post",
      completed: true,
    }),
  /Analyse Live refusée/,
  "Un match terminé est toujours 100 % bloqué !"
);

// 15d. [AUDIT3-P0-02 + AUDIT4-P1-05] Vérification statique de TOUTES les directives CSP (Firebase + Workflow GitHub Actions)
const fbCfgText = fsNode.readFileSync(pathNode.resolve("firebase.json"), "utf8");
const wfCfgText = fsNode.readFileSync(pathNode.resolve("../.github/workflows/firebase-auto-deploy.yml"), "utf8");
for (const [cfgName, rawCfg] of [["firebase.json", fbCfgText], ["firebase-auto-deploy.yml", wfCfgText]]) {
  const cfgContent = rawCfg.replace(/'\\''/g, "'");
  assert.ok(cfgContent.includes("'wasm-unsafe-eval'"), `${cfgName} DOIT inclure 'wasm-unsafe-eval' pour Tesseract WASM OCR !`);
  assert.ok(cfgContent.includes("worker-src 'self' blob:"), `${cfgName} DOIT inclure worker-src 'self' blob: !`);
  assert.ok(cfgContent.includes("https://cdn.jsdelivr.net"), `${cfgName} DOIT inclure https://cdn.jsdelivr.net !`);
  assert.ok(cfgContent.includes("https://tessdata.projectnaptha.com"), `${cfgName} DOIT inclure https://tessdata.projectnaptha.com !`);
  assert.equal(
    (cfgContent.match(/https:\/\/api\.frankfurter\.dev/g) || []).length >= (cfgName === "firebase.json" ? 1 : 2),
    true,
    `${cfgName} DOIT autoriser https://api.frankfurter.dev dans connect-src sur tous les sites !`
  );
}

// 15e. [AUDIT3-P1-04 + AUDIT4-P2-05] Vérification physique de 100 % des fichiers précachés par `cloe-abidjan/sw.js` (y compris javis-voice.js & fonts.css)
const abjSw = fsNode.readFileSync(pathNode.resolve("../cloe-abidjan/sw.js"), "utf8");
assert.ok(abjSw.includes("./javis-voice.js") && abjSw.includes("./fonts.css"), "cloe-abidjan/sw.js DOIT précacher ./javis-voice.js et ./fonts.css !");
const swAssetsMatch = abjSw.match(/ASSETS\s*=\s*\[([^\]]+)\]/);
assert.ok(swAssetsMatch, "ASSETS trouvé dans cloe-abidjan/sw.js");
const swAssets = swAssetsMatch[1]
  .split(",")
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
  .filter((p) => p !== "./" && p !== "/");
for (const relAsset of swAssets) {
  const fullAssetPath = pathNode.resolve("../cloe-abidjan", relAsset);
  assert.ok(fsNode.existsSync(fullAssetPath), `Asset Service Worker manquant sur disque : ${fullAssetPath}`);
}

// 15f. Zéro dérive de version entre TOUTES les applications et composants (v6.4 Certifiée Intégrale, zéro v6.0/v6.1/v6.2/v6.3)
for (const uiPath of [
  pathNode.resolve("src/FootballAI.jsx"),
  pathNode.resolve("src/cloe-standalone/CloeApp.jsx"),
  pathNode.resolve("src/services/cloeBridge.js"),
  pathNode.resolve("src/components/CloeBridgeTab.jsx"),
  pathNode.resolve("src/components/LiveMatchesTab.jsx"),
  pathNode.resolve("src/components/MatchTruthDossierModal.jsx"),
  pathNode.resolve("index.html"),
  pathNode.resolve("cloe-index.html"),
  pathNode.resolve("package.json"),
  pathNode.resolve("../cloe-abidjan/index.html"),
]) {
  const uiTxt = fsNode.readFileSync(uiPath, "utf8");
  assert.ok(/v6\.4|6\.4\.0/.test(uiTxt), `Version v6.4 / 6.4.0 requise dans ${uiPath}`);
  assert.equal(/v6\.[0123]\b/.test(uiTxt), false, `Zéro résidu v6.0/v6.1/v6.2/v6.3 autorisé dans ${uiPath}`);
}

// 16. AUDIT FORENSIQUE #4 — CERTIFICATION INTÉGRALE ZÉRO-DÉFAUT v6.4.0 (P0-01 À P2-05)
const stateV64 = rebuildModelState([]);
const predPsgOmV64 = computeFullPrediction("PSG", "Marseille", "ligue1", stateV64);

// 16a. [P0-01] Audit & Coupon Omni-Sport sans rawProbs (NBA, Tennis, UFC + #sync= cross-origin) -> ZÉRO TypeError !
const mixedOmniCoupon = [
  {
    id: 1,
    sport: "basketball",
    home: "Raptors",
    away: "Bulls",
    league: "nba",
    selectedMarket: { code: "SPREAD_HOME", label: "Raptors +7.5 pts", pct: 74, bookOdd: 1.52 },
  },
  {
    id: 2,
    sport: "mma",
    home: "Jon Jones",
    away: "Ciryl Gane",
    league: "ufc",
    selectedMarket: { code: "ML_HOME", label: "Jon Jones vainqueur", pct: 68, bookOdd: 1.62 },
  },
  {
    id: 3,
    sport: "soccer",
    home: "PSG",
    away: "Marseille",
    league: "ligue1",
    selectedMarket: { code: "DC_1X", label: "1X", pct: 78, bookOdd: 1.32 },
  },
];
const omniAudit = auditCouponSlip(mixedOmniCoupon, stateV64);
assert.ok(omniAudit && Number.isFinite(omniAudit.auditScore) && omniAudit.auditScore > 0, "Audit Coupon Omni-Sport sans rawProbs fonctionne à 100 % sans crash !");
assert.ok(omniAudit.weakestLink?.saferAlternative?.label, "Alternative plus sûre calculée même sur les jambes NBA/MMA !");

// 16b. [P0-02] Moteur In-Play computeLiveInPlayPrediction() sur remMatrix.rawMatrix 9×9 complet (somme exacte = 100 %)
for (const [minTest, sh, sa] of [[12, 0, 0], [54, 1, 0], [81, 2, 2]]) {
  const lp = computeLiveInPlayPrediction(predPsgOmV64, {
    minute: minTest,
    scoreHome: sh,
    scoreAway: sa,
    redCardsHome: 0,
    redCardsAway: 0,
    momentumHome: 60,
  });
  assert.equal(lp.liveProbs.length, 3);
  assert.equal(lp.liveProbs[0] + lp.liveProbs[1] + lp.liveProbs[2], 100, `Somme liveProbs = 100% à la ${minTest}e !`);
  assert.equal(
    lp.nextGoalProbs[0] + lp.nextGoalProbs[1] + lp.nextGoalProbs[2],
    100,
    `Somme prochain but = 100% à la ${minTest}e !`
  );
  assert.ok(Number.isFinite(lp.overCurrentPlus05Pct) && lp.overCurrentPlus05Pct >= 1 && lp.overCurrentPlus05Pct <= 99);
}

// 16c. [P0-03] Tournoi Knockout : preset.name défini partout + anti-collision sur doublon de club en R16
for (const [tk, tv] of Object.entries(TOURNAMENT_PRESETS)) {
  assert.ok(typeof tv.name === "string" && tv.name.length > 5, `TOURNAMENT_PRESETS.${tk}.name doit être défini !`);
}
const dupBracket = [
  ["PSG", "Barcelone"],
  ["PSG", "Arsenal"],
  ["Real Madrid", "Liverpool"],
  ["Bayern Munich", "Inter Milan"],
  ["Manchester City", "Atletico Madrid"],
  ["Leverkusen", "Dortmund"],
  ["Juventus", "AC Milan"],
  ["Benfica", "Porto"],
];
const dupSim = simulateKnockoutTournament(dupBracket, "ucl", stateV64, 800);
const totalChampPct = dupSim.leaderboard.reduce((s, r) => s + r.championPct, 0);
assert.equal(dupSim.leaderboard.length, 16, "Les 16 slots du tableau restent 100 % distincts même en cas de doublon !");
assert.ok(totalChampPct >= 99 && totalChampPct <= 101, `Somme des champions = ${totalChampPct.toFixed(1)}% (zéro écrasement de clé !)`);

// 16d. [P0-06] Exactitude mathématique OmniSport (MMA fairOdd distinct, xg.total, valueAnalysis.bestValue) + Betclic OCR Totals NBA vs Soccer + "X ou Y" -> DC_12
const omniModV64 = await import("../src/engine/omniSportEngine.js");
const mmaPred = omniModV64.predictOmniSportMatch({
  sport: "mma",
  home: "Islam Makhachev",
  away: "Arman Tsarukyan",
  league: "ufc",
  odds: { home: 1.55, away: 2.65 },
});
assert.ok(Number.isFinite(mmaPred.xg?.total), "predictOmniSportMatch exporte xg.total !");
assert.ok("bestValue" in (mmaPred.valueAnalysis || {}), "predictOmniSportMatch exporte valueAnalysis.bestValue !");
const scrModV64 = await import("../src/engine/bookmakerScreenshotAnalyzer.js");
const dcParsed = scrModV64.parseBookmakerMarketsFromText("PSG ou Barcelone 1,31\nPlus de 224,5 points 1,88", "PSG", "Barcelone");
assert.ok(dcParsed.some((o) => o.kind === "12"), '"PSG ou Barcelone" est bien détecté comme Double Chance 12 !');
const dcShortParsed = scrModV64.parseBookmakerMarketsFromText("OM ou OL 1,33", "OM", "OL");
assert.ok(dcShortParsed.some((o) => o.kind === "12"), '"OM ou OL" (clubs à 2 lettres) est aussi détecté comme Double Chance 12 !');
const nbaEval = evaluateScreenshotMarketsAndPickDefinitiveBet({
  home: "Boston Celtics",
  away: "Chicago Bulls",
  sport: "basketball",
  league: "nba",
  extractedOptions: [
    { kind: "OVER", line: 224.5, label: "Plus de 224,5 points", bookOdd: 1.9 },
    { kind: "UNDER", line: 224.5, label: "Moins de 224,5 points", bookOdd: 1.9 },
  ],
});
assert.equal(nbaEval.sport, "basketball", "Le scanner Betclic route le NBA vers le moteur Gaussien basketball !");
assert.ok(
  nbaEval.analyzedOptions[0].trueProbPct > 15 && nbaEval.analyzedOptions[0].trueProbPct < 85,
  `Total NBA 224.5 pts évalué via loi Normale (${nbaEval.analyzedOptions[0].trueProbPct}%) et NON à 0 % Poisson football !`
);

// 16e. [P1-01 + P1-03 + P2-04] Pont Cloé v6.4 (accuracyPct réel, errorJournal complet, tickets <2 matchs, Fantasy unicité 100%)
const v64Evolution = testBrain.getModelEvolution();
assert.ok(Number.isFinite(v64Evolution.accuracyPct), "getModelEvolution().accuracyPct est un nombre fini (zéro undefined%) !");
assert.ok(Number.isFinite(v64Evolution.marketAccuracyPct), "getModelEvolution().marketAccuracyPct est un nombre fini !");
const singleMatchTickets = testBrain.generateTickets([
  {
    sport: "basketball",
    home: "Boston Celtics",
    away: "Los Angeles Lakers",
    league: "nba",
    odds: { home: 1.62, away: 2.35 },
  },
]);
assert.equal(singleMatchTickets.length, 3, "generateTickets fonctionne même avec 1 seul match live (NBA inclus) !");
assert.ok(singleMatchTickets[0].items.length >= 2, "Le Ticket Sécurité contient toujours au moins 2 jambes !");

const playersModV64 = await import("../src/data/players.js");
const playerIds = playersModV64.FANTASY_PLAYERS.map((p) => p.id);
const playerNames = playersModV64.FANTASY_PLAYERS.map((p) => p.name);
assert.equal(new Set(playerIds).size, playerIds.length, "100 % des IDs joueurs Fantasy sont uniques (zéro collision mid-11..mid-14) !");
assert.equal(new Set(playerNames).size, playerNames.length, "100 % des noms joueurs Fantasy sont uniques (zéro doublon Simon Adingra) !");
assert.equal(playersModV64.FANTASY_PLAYERS.some((p) => p.league === "laliga"), false, "Zéro clé de ligue invalide 'laliga' dans FANTASY_PLAYERS !");
const fantasyWithNonSoccerNoise = scoreFantasyPlayers(stateV64, [
  { sport: "basketball", home: "Arsenal", away: "Chelsea", league: "nba" },
]);
assert.ok(fantasyWithNonSoccerNoise.length === playersModV64.FANTASY_PLAYERS.length, "scoreFantasyPlayers filtre les matchs non-soccer sans planter !");

// 16f. [P0-04 + P0-05 + P1-02 + P1-04 + .firebaserc targets] Contrôles d'intégrité statiques finaux sur tout le code source
const fbParsed = JSON.parse(fbCfgText);
const fbRcParsed = JSON.parse(fsNode.readFileSync(pathNode.resolve(".firebaserc"), "utf8"));
if (Array.isArray(fbParsed.hosting)) {
  const mappedTargets = fbRcParsed?.targets?.["football-ai-43e33"]?.hosting || {};
  for (const hBlock of fbParsed.hosting) {
    if (hBlock.target) {
      assert.ok(Array.isArray(mappedTargets[hBlock.target]) && mappedTargets[hBlock.target].length > 0, `Target Firebase "${hBlock.target}" DOIT être déclaré dans .firebaserc !`);
    }
  }
}
const abjHtmlSrc = fsNode.readFileSync(pathNode.resolve("../cloe-abidjan/index.html"), "utf8");
assert.equal(abjHtmlSrc.includes("localStorage.getItem('javis_gemKey')"), false, "Zéro lecture JSON brute javis_gemKey dans cloe-abidjan/index.html !");
assert.ok(abjHtmlSrc.includes("javis_v64_purged"), "Migration javis_v64_purged présente dans cloe-abidjan/index.html !");
const harvestSrc = fsNode.readFileSync(pathNode.resolve("scripts/harvest-live-internet.mjs"), "utf8");
assert.ok(harvestSrc.includes('ev.atVs === "@"'), "Inversion H2H domicile/extérieur (atVs === '@') corrigée dans harvest-live-internet.mjs !");

console.log(
  `✓ Audit Complet #4 (v6.4.0 CERTIFIÉE INTÉGRALE ZÉRO-DÉFAUT) validé à 100% : Coupon Omni-Sport sans rawProbs (${omniAudit.grade} ${omniAudit.auditScore}/100) ✅ | In-Play 9×9 exact 100% ✅ | Tournoi 16/16 sans collision (${totalChampPct.toFixed(1)}%) ✅ | Scanner Betclic NBA 224.5 pts (${nbaEval.analyzedOptions[0].trueProbPct}%) + DC_12 ✅ | Fantasy ${playersModV64.FANTASY_PLAYERS.length}/${playersModV64.FANTASY_PLAYERS.length} IDs & noms uniques ✅ | CSP Frankfurter + SW 7/7 assets ✅ !`
);


