#!/usr/bin/env node
/**
 * Génère le flux JSON universel temps réel https://football-ai-43e33.web.app/cloe-data-v5.json
 * (CORS ouvert * — consommable par n'importe quelle application Web, Android APK, Flutter, Python ou Cloé · Agent personnel · Abidjan)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLUBS_DB, LEAGUES } from "../src/data/clubs.js";
import { rebuildModelState, computeFullPrediction } from "../src/engine/predictor.js";
import { computeProMatchMarkets } from "../src/engine/proMarketsEngine.js";
import { generateThreeDailyTickets } from "../src/engine/ticketGenerator.js";
import { TOURNAMENT_PRESETS, simulateKnockoutTournament } from "../src/engine/tournamentSimulator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(__dirname, "../www/cloe-data-v5.json");

const modelState = rebuildModelState([]);
const teamsCount = Object.keys(CLUBS_DB).length;

const featuredMatches = [
  ["ASEC Mimosas", "Al Ahly", "caf"],
  ["PSG", "Marseille", "ligue1"],
  ["Real Madrid", "Barcelone", "liga"],
  ["Liverpool", "Arsenal", "premier"],
  ["Al-Hilal", "Al-Nassr", "saudi"],
  ["Côte d'Ivoire", "Maroc", "international"],
].map(([home, away, leagueId]) => {
  const pred = computeFullPrediction(home, away, leagueId, modelState);
  const pro = computeProMatchMarkets(pred);
  return {
    home,
    away,
    leagueId,
    probabilities1X2: pred.probs,
    expectedGoals: pred.xg,
    recommendedMarket: pred.recommendedMarket,
    confidence: pred.confidence,
    topScorers: pro.topScorers.slice(0, 4),
    corners: pro.corners,
    cards: pro.cards,
    halfTime: pro.halfTime,
  };
});

const tournaments = Object.keys(TOURNAMENT_PRESETS).reduce((acc, key) => {
  const preset = TOURNAMENT_PRESETS[key];
  const sim = simulateKnockoutTournament(preset.roundOf16, preset.league || "ucl", modelState, 5000);
  acc[key] = {
    name: preset.name || key.toUpperCase(),
    simulations: 5000,
    topFavorites: sim.leaderboard.slice(0, 8),
  };
  return acc;
}, {});

const dailyTickets = generateThreeDailyTickets([], modelState);

const safeTicketSummary = dailyTickets[0]?.noBet
  ? "Aucun ticket automatique proposé sans événements futurs, récents et vérifiés."
  : `Ticket automatique estimé à la cote ${dailyTickets[0].totalOdd.toFixed(2)} (sans garantie).`;

const payload = {
  engine: "Omni-Sport & Football AI Ultra v6.4 Certifiée Intégrale",
  version: "6.4.0",
  updatedAt: new Date().toISOString(),
  sourceAppUrl: "https://football-ai-43e33.web.app",
  cloeAbidjanUrl: "https://cloe-agent-abidjan.web.app",
  cloeStandaloneUrl: "https://cloe-ia-ultra.web.app",
  bridgeScriptUrl: "https://football-ai-43e33.web.app/cloe-bridge.js",
  teamsCount,
  leagues: LEAGUES,
  featuredMatches,
  dailyTickets,
  tournaments,
  voiceSummaryFr:
    `Point Omni-Sport & Football AI Ultra v6.4 Certifiée Intégrale : ${teamsCount} clubs et nations actifs. ` +
    `Favori numéro 1 CAN sur 5 000 simulations : ${tournaments.can.topFavorites[0].team} (${tournaments.can.topFavorites[0].championPct}%). ` +
    `Favori Champions League : ${tournaments.ucl.topFavorites[0].team} (${tournaments.ucl.topFavorites[0].championPct}%). ` +
    safeTicketSummary,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
console.log(`✓ cloe-data-v5.json généré (${teamsCount} équipes, ${Math.round(fs.statSync(OUT_FILE).size / 1024)} Ko)`);
