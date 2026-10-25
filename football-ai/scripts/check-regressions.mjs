// Contrôles ciblés de non-régression, sans dépendance externe ni accès réseau.
// Exécuter avec : npm run test:regressions
import assert from "node:assert/strict";
import {
  checkPickResult,
  computeForecastPerformance,
  isPerformanceEligible,
  rebuildModelState,
  roundProbabilitiesTo100,
  runContinuousEvolution,
} from "../src/engine/predictor.js";
import {
  hasRealOdd,
  isRealOdd,
  legEdgePct,
  realOddOf,
} from "../src/engine/oddsPolicy.js";
import { generateThreeDailyTickets } from "../src/engine/ticketGenerator.js";
import { evaluateScreenshotMarketsAndPickDefinitiveBet } from "../src/engine/bookmakerScreenshotAnalyzer.js";

// Les marchés de buts exigent un score complet; le 1X2 seul ne suffit pas.
assert.equal(
  checkPickResult({ result: 1, probs: [40, 30, 30], selectedMarket: { code: "O25" } }),
  null
);
assert.equal(
  checkPickResult({ result: 0, probs: [40, 30, 30], selectedMarket: { code: "U25" } }),
  null
);
assert.equal(
  checkPickResult({ result: 0, scoreHome: 2, scoreAway: 1, selectedMarket: { code: "O25" } }),
  true
);
assert.equal(
  checkPickResult({ result: 1, scoreHome: 1, scoreAway: 1, selectedMarket: { code: "U25" } }),
  true
);
assert.equal(
  checkPickResult({ result: 0, scoreHome: 1, scoreAway: 0, selectedMarket: { code: "BTTS_N" } }),
  true
);
assert.equal(
  checkPickResult({ result: 0, scoreHome: 1, selectedMarket: { code: "BTTS_N" } }),
  null
);

const official = {
  externalId: "event-1",
  predictionPhase: "pre-match",
  performanceEligible: true,
  autoLearned: false,
  verifiedResult: true,
  verifiedResultExternalId: "event-1",
  resultSource: "official-feed",
  scoreHome: 2,
  scoreAway: 0,
  result: 0,
  forecastIssuedAtIso: "2026-01-01T10:00:00Z",
  kickoffIso: "2026-01-01T15:00:00Z",
  resultObservedAtIso: "2026-01-01T17:00:00Z",
};
assert.equal(isPerformanceEligible(official), true);
assert.equal(
  isPerformanceEligible({ ...official, predictionOrigin: "historical-test-fixture" }),
  false,
  "un fixture de test historique ne doit pas entrer dans la performance prospective"
);
const overUnderForecasts = [
  {
    ...official,
    externalId: "over-under-no-score",
    verifiedResultExternalId: "over-under-no-score",
    probs: [60, 25, 15],
    selectedMarket: { code: "O25" },
    scoreHome: undefined,
    scoreAway: undefined,
  },
  {
    ...official,
    externalId: "over-under-scored",
    verifiedResultExternalId: "over-under-scored",
    probs: [60, 25, 15],
    selectedMarket: { code: "O25" },
    scoreHome: 2,
    scoreAway: 1,
  },
];
const overUnderMetrics = computeForecastPerformance(overUnderForecasts, 1);
assert.equal(overUnderMetrics.total, 1, "un résultat sans score réel est exclu de la performance prospective");
assert.equal(overUnderMetrics.marketSampleSize, 1);
assert.equal(overUnderMetrics.marketCorrect, 1);
assert.equal(overUnderMetrics.marketAccuracyPct, 100);
assert.equal(
  computeForecastPerformance(overUnderForecasts, 2).marketAccuracyPct,
  null,
  "la précision marché reste masquée tant que l'échantillon marché est inférieur au seuil"
);

const trainingMarketMetrics = rebuildModelState([
  {
    id: 901,
    externalId: "training-over-under-no-score",
    home: "PSG",
    away: "Lyon",
    league: "ligue1",
    result: 0,
    probs: [60, 20, 20],
    selectedMarket: { code: "O25" },
  },
  {
    id: 902,
    externalId: "training-over-under-scored",
    home: "Marseille",
    away: "Lille",
    league: "ligue1",
    result: 0,
    scoreHome: 2,
    scoreAway: 1,
    probs: [60, 20, 20],
    selectedMarket: { code: "O25" },
  },
]).trainingMetrics;
assert.equal(trainingMarketMetrics.total, 2);
assert.equal(trainingMarketMetrics.marketSampleSize, 1);
assert.equal(trainingMarketMetrics.marketCorrect, 1);
assert.equal(trainingMarketMetrics.marketAccuracyPct, 100);

// NaN, Infinity et vecteur vide ne doivent jamais produire de probabilités non finies.
for (const invalid of [
  [NaN, 0.2, 0.3],
  [Infinity, 1, 1],
  [0, 0, 0],
]) {
  const rounded = roundProbabilitiesTo100(invalid);
  assert.ok(rounded.every(Number.isFinite));
  assert.equal(rounded.reduce((sum, value) => sum + value, 0), 100);
}
assert.deepEqual(roundProbabilitiesTo100([]), []);
assert.equal(roundProbabilitiesTo100([0.5, 0.3, 0.2]).reduce((a, b) => a + b, 0), 100);

// Les cotes estimées et les valeurs sans source restent exclues.
assert.equal(isRealOdd(1.9), true);
assert.equal(isRealOdd(1.01), false);
assert.equal(isRealOdd(undefined), false);
for (const source of ["feed", "manual", "screenshot"]) {
  assert.equal(hasRealOdd({ bookOdd: 2.1, oddSource: source }), true);
}
assert.equal(hasRealOdd({ bookOdd: 2.1, oddSource: "estimated" }), false);
assert.equal(hasRealOdd({ bookOdd: 2.1, oddSource: "unverified" }), false);
assert.equal(hasRealOdd({ bookOdd: 2.1 }), false);
assert.equal(hasRealOdd({ marketOdd: 2.1, oddSource: "feed" }), false);
const oneXTwo = { code: "1", group: "1X2", marketOdd: 1.5 };
assert.equal(
  realOddOf({ valueAnalysis: { items: [{ code: "1", bookOdd: 2.2, oddSource: "feed" }] } }, oneXTwo),
  2.2
);
assert.equal(
  realOddOf({ valueAnalysis: { items: [{ code: "1", bookOdd: 2.2, oddSource: "unverified" }] } }, oneXTwo),
  null
);
assert.equal(legEdgePct({}, oneXTwo), null);

const emptyState = rebuildModelState([]);
const noOddScreenshot = evaluateScreenshotMarketsAndPickDefinitiveBet({
  home: "PSG",
  away: "Marseille",
  modelState: emptyState,
  extractedOptions: [{ kind: "1", label: "Victoire domicile" }],
});
assert.equal(noOddScreenshot.analyzedOptions.length, 0, "aucune cote de repli ne doit être inventée");
assert.equal(noOddScreenshot.definitiveBet, null);
const missingTeams = evaluateScreenshotMarketsAndPickDefinitiveBet({
  home: "",
  away: "",
  modelState: emptyState,
  extractedOptions: [{ kind: "1", bookOdd: 2.1 }],
});
assert.equal(missingTeams.ok, false, "ne pas substituer des équipes par défaut");
assert.equal(missingTeams.definitiveBet, null);

// Barrière d'auto-évolution : 8 résultats ne changent ni les hyperparamètres ni la génération.
const fewHistory = Array.from({ length: 8 }, (_, index) => ({
  ...official,
  externalId: `few-${index}`,
  verifiedResultExternalId: `few-${index}`,
  id: index + 1,
  home: "PSG",
  away: "Lyon",
  league: "ligue1",
  kickoffIso: `2026-01-${String(index + 1).padStart(2, "0")}T15:00:00Z`,
  forecastIssuedAtIso: `2026-01-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
  resultObservedAtIso: `2026-01-${String(index + 1).padStart(2, "0")}T17:00:00Z`,
  probs: [50, 25, 25],
  rawProbs: [0.5, 0.25, 0.25],
}));
const fewEvolution = runContinuousEvolution(fewHistory, { dcWeight: 0.7, generation: 3 });
assert.equal(fewEvolution.evolvedHyper.dcWeight, 0.7);
assert.equal(fewEvolution.evolvedHyper.generation, 3);

// À partir de 12 résultats, le rejeu doit réserver les 30 % les plus récents au holdout.
const evolutionHistory = Array.from({ length: 12 }, (_, index) => {
  const day = String(index + 1).padStart(2, "0");
  const result = index % 3;
  return {
    ...official,
    id: index + 1,
    externalId: `evolution-${index}`,
    verifiedResultExternalId: `evolution-${index}`,
    home: ["PSG", "Lyon", "Monaco", "Lille"][index % 4],
    away: ["Marseille", "Nice", "Lens", "Rennes"][index % 4],
    league: "ligue1",
    result,
    scoreHome: result === 0 ? 2 : result === 1 ? 1 : 0,
    scoreAway: result === 2 ? 2 : result === 1 ? 1 : 0,
    probs: [0.48, 0.28, 0.24].map((value, outcome) =>
      Math.round((value + (index % 2 ? 0.015 : -0.015) * (outcome - 1)) * 100)
    ),
    rawProbs: [0.48, 0.28, 0.24],
    kickoffIso: `2026-02-${day}T15:00:00Z`,
    forecastIssuedAtIso: `2026-02-${day}T10:00:00Z`,
    resultObservedAtIso: `2026-02-${day}T17:00:00Z`,
  };
});
const evolution = runContinuousEvolution(evolutionHistory, { dcWeight: 0.64, generation: 4 });
assert.equal(evolution.holdoutGate.trainMatches, 8);
assert.equal(evolution.holdoutGate.holdoutMatches, 4);
if (evolution.holdoutGate.accepted) {
  assert.ok(evolution.afterBrier <= evolution.beforeBrier);
  assert.equal(evolution.evolvedHyper.generation, 5);
} else {
  assert.equal(evolution.afterBrier, evolution.beforeBrier);
  assert.equal(evolution.evolvedHyper.generation, 4);
}

// Fixture frais de test pour vérifier le NO-BET du générateur sans cote réelle.
const freshNow = Date.now();
const freshFixture = (id, home, away, prediction) => ({
  externalId: id,
  home,
  away,
  league: "ligue1",
  sport: "soccer",
  isRealInternet: true,
  isLiveNetwork: true,
  isSnapshot: false,
  isCached: false,
  state: "pre",
  completed: false,
  kickoffIso: new Date(freshNow + 60 * 60 * 1000).toISOString(),
  fetchedAtIso: new Date(freshNow).toISOString(),
  statusVerifiedAtIso: new Date(freshNow).toISOString(),
  statusVerificationSource: "test-feed",
  prediction,
});
const makePrediction = (home, away, withRealOdds) => {
  const market = { code: "1", group: "1X2", label: `Victoire ${home}`, pct: 75, prob: 0.75, marketOdd: 1.6 };
  return {
    sport: "soccer",
    home,
    away,
    probs: [75, 15, 10],
    rawProbs: [0.75, 0.15, 0.1],
    markets: [market],
    recommendedMarket: market,
    reliabilityGate: { allowAutoTicket: true },
    ...(withRealOdds
      ? {
          valueAnalysis: {
            items: [{ code: "1", bookOdd: 1.8, oddSource: "feed", evPct: 35 }],
          },
        }
      : {}),
  };
};
const fixturesWithoutOdds = [
  freshFixture("no-odd-1", "PSG", "Marseille", makePrediction("PSG", "Marseille", false)),
  freshFixture("no-odd-2", "Lyon", "Lille", makePrediction("Lyon", "Lille", false)),
];
const noOddTickets = generateThreeDailyTickets(fixturesWithoutOdds, emptyState);
assert.equal(noOddTickets.length, 3);
assert.ok(noOddTickets.every((ticket) => ticket.noBet && ticket.items.length === 0));

const fixturesWithOdds = [
  freshFixture("real-odd-1", "PSG", "Marseille", makePrediction("PSG", "Marseille", true)),
  freshFixture("real-odd-2", "Lyon", "Lille", makePrediction("Lyon", "Lille", true)),
];
const verifiedTickets = generateThreeDailyTickets(fixturesWithOdds, emptyState);
assert.equal(verifiedTickets[0].noBet, false);
assert.equal(verifiedTickets[0].items.length, 2);
assert.ok(verifiedTickets[0].items.every((item) => hasRealOdd(item.selectedMarket)));

console.log("✓ Régressions : scores vérifiables, sources de cotes, NO-BET, holdout chronologique et probabilités finies.");
