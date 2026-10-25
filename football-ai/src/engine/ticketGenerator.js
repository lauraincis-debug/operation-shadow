import { computeFullPrediction } from "./predictor.js";
import { predictOmniSportMatch } from "./omniSportEngine.js";
import { resolveClub } from "../data/clubs.js";
import { isMatchFeedFresh } from "../services/liveMatchesApi.js";
import { hasRealOdd, realOddDetailsOf, legEdgePct } from "./oddsPolicy.js";

/**
 * Générateur des trois tickets du jour. Une cote calculée par le modèle n'est jamais une cote bookmaker.
 * Les tickets automatiques ne retiennent que les marchés 1X2 à cote réelle vérifiée; sinon, NO-BET.
 */
export function isEligibleTicketFixture(fixture, now = Date.now()) {
  if (
    !fixture ||
    fixture.isRealInternet !== true ||
    !fixture.externalId ||
    !fixture.kickoffIso ||
    fixture.completed === true ||
    fixture.state !== "pre" ||
    !isMatchFeedFresh(fixture, now)
  ) return false;
  const kickoff = new Date(fixture.kickoffIso).getTime();
  return Number.isFinite(kickoff) && kickoff > now;
}

export function scanSmartMoneyOpportunities(fixtures = [], modelState) {
  const candidates = Array.isArray(fixtures) ? fixtures : [];
  const seen = new Set();
  const sourceList = candidates.filter((fixture) => {
    if (!isEligibleTicketFixture(fixture)) return false;
    const id = String(fixture.externalId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const schemaCounts = {};

  const analyzed = sourceList.map((fixture) => {
    const sport = fixture.sport || fixture.prediction?.sport || "soccer";
    const resolvedLeague = fixture.league || resolveClub(fixture.home)?.leagues?.[0] || "ucl";
    const prediction =
      fixture.prediction ||
      (sport === "soccer"
        ? computeFullPrediction(
            fixture.home,
            fixture.away,
            resolvedLeague,
            modelState,
            fixture.liveOdds || null,
            {
              neutralVenue: fixture.neutralSite,
              liveIntel: fixture,
              schemaCounts,
            }
          )
        : predictOmniSportMatch({ ...fixture, sport }));

    if (prediction?.recommendedMarket?.code) {
      const code = prediction.recommendedMarket.code;
      schemaCounts[code] = (schemaCounts[code] || 0) + 1;
    }

    // realOddDetailsOf vérifie l'origine (flux/mise saisie) et refuse fairOdd/marketOdd.
    const realMarkets = (prediction?.markets || [])
      .map((market) => {
        const details = realOddDetailsOf(prediction, market);
        return details
          ? {
              ...market,
              bookOdd: Number(details.bookOdd),
              oddSource: details.oddSource,
            }
          : null;
      })
      .filter((market) => hasRealOdd(market));

    const safeCandidates = realMarkets.filter((market) => market.pct >= 72 && market.bookOdd >= 1.16);
    const balancedCandidates = realMarkets.filter(
      (market) => market.pct >= 56 && market.pct <= 78 && market.bookOdd >= 1.38
    );
    const highOddCandidates = realMarkets.filter((market) => market.pct >= 38 && market.bookOdd >= 1.95);

    const bestSafe = [...safeCandidates].sort((a, b) => b.pct - a.pct)[0] || null;
    const bestBalanced =
      [...balancedCandidates].sort((a, b) => b.pct * b.bookOdd - a.pct * a.bookOdd)[0] || null;
    const bestHigh =
      [...highOddCandidates].sort(
        (a, b) => b.pct * Math.sqrt(b.bookOdd) - a.pct * Math.sqrt(a.bookOdd)
      )[0] || null;
    const edgePct = bestBalanced ? legEdgePct(prediction, bestBalanced) : null;

    return {
      fixture: { ...fixture, sport, league: resolvedLeague },
      pred: prediction,
      hasRealOdds: realMarkets.length > 0,
      bestSafe,
      bestBalanced,
      bestHigh,
      edgePct,
      isSmartValue: edgePct !== null && edgePct >= 4.5,
    };
  });

  return analyzed.filter(
    (entry) => entry.hasRealOdds && entry.pred?.reliabilityGate?.allowAutoTicket === true
  );
}

function buildCouponItemsFromPicks(picks) {
  let combinedOdd = 1;
  let combinedProb = 1;
  const items = picks
    .filter((entry) => hasRealOdd(entry.chosenMarket))
    .map((entry, idx) => {
      const market = entry.chosenMarket;
      const odd = Number(market.bookOdd);
      const prob = Math.min(0.98, Math.max(0.03, market.prob ?? (market.pct || 65) / 100));
      combinedOdd *= odd;
      combinedProb *= prob;
      const probs = Array.isArray(entry.pred.probs) ? entry.pred.probs : [33, 34, 33];
      return {
        id: Date.now() + idx * 17 + Math.floor(Math.random() * 100),
        sport: entry.fixture.sport || entry.pred.sport || "soccer",
        home: entry.pred.home,
        away: entry.pred.away,
        league: entry.fixture.league || "ucl",
        probs,
        rawProbs: Array.isArray(entry.pred.rawProbs)
          ? entry.pred.rawProbs
          : probs.map((value) => Number(value) / 100),
        selectedMarket: {
          ...market,
          prob,
          pct: Math.round(prob * 100),
          bookOdd: odd,
          oddSource: market.oddSource,
        },
      };
    });

  return {
    items,
    totalOdd: items.length ? Math.round(combinedOdd * 100) / 100 : null,
    winProbPct: items.length ? Math.max(1, Math.round(combinedProb * 1000) / 10) : null,
  };
}

function buildTicket(meta, built) {
  if (built.items.length < 2) {
    const reason =
      "Moins de deux sélections disposent d'une cote réelle pour ce profil : aucun combiné n'est généré.";
    return {
      id: meta.id,
      badge: "⛔ NO-BET",
      title: `${meta.title} indisponible`,
      subtitle: reason,
      recommendedBankrollPct: 0,
      accent: "#ff1744",
      items: [],
      totalOdd: null,
      winProbPct: null,
      noBet: true,
      noBetReason: reason,
    };
  }
  return { ...meta, ...built, noBet: false };
}

function noBetTickets(reason) {
  return [
    { id: "safe", title: "Ticket sécurité indisponible", reason },
    { id: "value", title: "Ticket value indisponible", reason },
    { id: "jackpot", title: "Ticket cote boost indisponible", reason },
  ].map(({ id, title, reason: noBetReason }) => ({
    id,
    badge: "⛔ NO-BET",
    title,
    subtitle: noBetReason,
    recommendedBankrollPct: 0,
    accent: "#ff1744",
    items: [],
    totalOdd: null,
    winProbPct: null,
    noBet: true,
    noBetReason,
  }));
}

export function generateThreeDailyTickets(fixtures = [], modelState) {
  const pool = scanSmartMoneyOpportunities(fixtures, modelState);
  if (pool.length < 2) {
    const reason = pool.length === 1
      ? "Une seule affiche répond aux critères stricts (cote réelle, fraîche et autorisée); aucun combiné n'est généré."
      : "Aucune paire de matchs à venir ne dispose de cotes réelles, fraîches et vérifiables.";
    return noBetTickets(reason);
  }

  const safeSorted = pool
    .filter((entry) => entry.bestSafe)
    .sort((a, b) => b.bestSafe.pct - a.bestSafe.pct)
    .slice(0, 3)
    .map((entry) => ({ ...entry, chosenMarket: entry.bestSafe }));
  const balancedSorted = pool
    .filter((entry) => entry.bestBalanced)
    .sort(
      (a, b) =>
        (b.edgePct ?? -Infinity) - (a.edgePct ?? -Infinity) ||
        b.bestBalanced.pct - a.bestBalanced.pct
    )
    .slice(0, 4)
    .map((entry) => ({ ...entry, chosenMarket: entry.bestBalanced }));
  const highSorted = pool
    .filter((entry) => entry.bestHigh)
    .sort(
      (a, b) =>
        b.bestHigh.bookOdd * b.bestHigh.pct - a.bestHigh.bookOdd * a.bestHigh.pct
    )
    .slice(0, 5)
    .map((entry) => ({ ...entry, chosenMarket: entry.bestHigh }));

  return [
    buildTicket(
      {
        id: "safe",
        badge: "🛡️ SÉCURITÉ IA",
        title: "Ticket Bouclier Haute Fiabilité",
        subtitle: "Sélections à forte probabilité, cotes bookmaker réelles uniquement",
        recommendedBankrollPct: 4.0,
        accent: "#00e676",
      },
      buildCouponItemsFromPicks(safeSorted)
    ),
    buildTicket(
      {
        id: "value",
        badge: "⚖️ VALUE BET PRO",
        title: "Ticket Équilibré Smart Money",
        subtitle: "Écart de valeur mesuré exclusivement sur des cotes réelles",
        recommendedBankrollPct: 2.5,
        accent: "#00e5ff",
      },
      buildCouponItemsFromPicks(balancedSorted)
    ),
    buildTicket(
      {
        id: "jackpot",
        badge: "🚀 COTE BOOST / FUN",
        title: "Ticket Multi-Cote Haute Performance",
        subtitle: "Sélections ambitieuses, cotes bookmaker réelles uniquement",
        recommendedBankrollPct: 1.0,
        accent: "#d500f9",
      },
      buildCouponItemsFromPicks(highSorted)
    ),
  ];
}

/**
 * 📸 Génère et télécharge une vraie Carte Graphique HD (PNG 1080px) du Ticket Signé Football AI Ultra
 */
export function exportCouponAsPngImage({ coupon, stake, currency, totalOdd, winProbPct, potentialGain }) {
  if (typeof document === "undefined" || !Array.isArray(coupon) || coupon.length === 0) return false;

  const allOddsVerified = coupon.every((item) => hasRealOdd(item.selectedMarket));
  const width = 920;
  const rowHeight = 96;
  const height = 340 + coupon.length * rowHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  // Fond sombre néon signature Football AI Ultra
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#080b1f");
  bg.addColorStop(0.5, "#10163b");
  bg.addColorStop(1, "#070919");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Bordure néon
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 18, width - 36, height - 36);

  // En-tête
  ctx.fillStyle = "#00e5ff";
  ctx.font = "bold 34px system-ui, -apple-system, sans-serif";
  ctx.fillText(
    allOddsVerified
      ? "⚡ OMNI-SPORT & FOOTBALL AI ULTRA v6.4 • COTES VÉRIFIÉES"
      : "⚡ OMNI-SPORT & FOOTBALL AI ULTRA v6.4 • COTES À VÉRIFIER",
    48,
    78
  );

  ctx.fillStyle = "#94a3b8";
  ctx.font = "600 20px system-ui, -apple-system, sans-serif";
  ctx.fillText(
    `Généré le ${new Date().toLocaleDateString("fr-FR")} • ${coupon.length} sélection(s) • probabilités estimées`,
    48,
    114
  );

  // Liste des matchs
  coupon.forEach((item, i) => {
    const y = 145 + i * rowHeight;
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    ctx.fillRect(48, y, width - 96, rowHeight - 14);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 24px system-ui, -apple-system, sans-serif";
    ctx.fillText(`${i + 1}. ${item.home}  vs  ${item.away}`, 68, y + 34);

    ctx.fillStyle = "#00e676";
    ctx.font = "bold 21px system-ui, -apple-system, sans-serif";
    ctx.fillText(`🎯 ${item.selectedMarket?.label || "Choix IA"} (${item.selectedMarket?.pct || 70}% IA)`, 68, y + 66);

  ctx.fillStyle = "#fbbf24";
  ctx.font = "bold 22px system-ui, -apple-system, sans-serif";
  const oddTxt = hasRealOdd(item.selectedMarket)
    ? `@${Number(item.selectedMarket.bookOdd).toFixed(2)}`
    : "COTE À VÉRIFIER";
  ctx.fillText(oddTxt, width - 220, y + 52);
  });

  // Pied de ticket récapitulatif
  const footerY = 165 + coupon.length * rowHeight;
  ctx.fillStyle = "rgba(0, 229, 255, 0.12)";
  ctx.fillRect(48, footerY, width - 96, 125);

  const fmt = (val) => {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return "—";
    return currency === "EUR"
      ? `${Number(val).toFixed(2)} €`
      : `${Math.round(Number(val)).toLocaleString("fr-FR")} FCFA`;
  };
  const displayedTotal =
    allOddsVerified && totalOdd !== null && totalOdd !== undefined && Number.isFinite(Number(totalOdd))
      ? Number(totalOdd).toFixed(2)
    : "COTES À VÉRIFIER";

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 24px system-ui, -apple-system, sans-serif";
  ctx.fillText(`Cote Totale : ${displayedTotal}   |   Probabilité estimée : ${winProbPct ?? "—"}%`, 68, footerY + 46);

  ctx.fillStyle = "#00e676";
  ctx.font = "bold 32px system-ui, -apple-system, sans-serif";
  const payoutLabel = allOddsVerified ? fmt(potentialGain) : "non calculé";
  ctx.fillText(`Mise ${fmt(stake)}  ➔  Gain Potentiel : ${payoutLabel}`, 68, footerY + 94);

  const link = document.createElement("a");
  link.download = `ticket-football-ai-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  return true;
}
