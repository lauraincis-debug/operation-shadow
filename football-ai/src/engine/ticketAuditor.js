import { computeFullPrediction } from "./predictor.js";
import { extractTeamsFromQuestion } from "../services/cloeBridge.js";

/**
 * 📸 AUDIT IA DE TICKET & DÉTECTEUR DE MAILLON FAIBLE
 * Analyse mathématiquement chaque ligne d'un combiné :
 * - Identifie le MAILLON FAIBLE n°1 qui menace tout le coupon
 * - Attribue une Note de Survie (/100) et un Grade (A+ à D)
 * - Propose en 1 clic le remplacement sécurisé optimal
 * - Permet aussi de coller n'importe quel texte de ticket externe (1xBet, Betclic, Sportcash...)
 */

export function auditCouponSlip(coupon = [], modelState) {
  if (!Array.isArray(coupon) || coupon.length === 0) {
    return null;
  }

  let combinedSurvival = 1;
  const inspected = coupon.map((item, index) => {
    const pred = computeFullPrediction(
      item.home,
      item.away,
      item.league || "ucl",
      modelState,
      null
    );
    const chosenPct = Number(item.selectedMarket?.pct || 60);
    const saferAlt = pred.recommendedMarket;
    const gainSafety = Math.max(0, (saferAlt?.pct || chosenPct) - chosenPct);

    combinedSurvival *= Math.min(0.98, Math.max(0.05, chosenPct / 100));

    let riskTag = "🟢 Solide";
    if (chosenPct < 50) riskTag = "🔴 Piège Critique";
    else if (chosenPct < 65) riskTag = "🟠 Vigilance";

    return {
      index,
      itemId: item.id,
      matchLabel: `${pred.home} vs ${pred.away}`,
      chosenLabel: item.selectedMarket?.label || "Sélection",
      chosenPct,
      chosenOdd: Number(item.selectedMarket?.bookOdd || 1.5),
      saferAlternative: {
        ...saferAlt,
        bookOdd: Number(saferAlt.marketOdd || 1.35),
      },
      gainSafetyPct: gainSafety,
      riskTag,
      canUpgrade: saferAlt && saferAlt.code !== item.selectedMarket?.code && gainSafety >= 6,
    };
  });

  // Trouver le maillon le plus faible (probabilité IA la plus basse)
  const sortedByWeakness = [...inspected].sort((a, b) => a.chosenPct - b.chosenPct);
  const weakestLink = sortedByWeakness[0];

  const survivalPct = Math.round(combinedSurvival * 1000) / 10;
  const avgLegPct =
    inspected.reduce((acc, x) => acc + x.chosenPct, 0) / Math.max(1, inspected.length);

  // Score qualité global /100 pondérant probabilité combinée et solidité individuelle
  const rawScore = Math.round(0.55 * avgLegPct + 0.45 * Math.min(95, survivalPct * 1.45));
  const auditScore = Math.min(98, Math.max(18, rawScore));

  let grade = "A";
  let verdictColor = "#00e676";
  if (auditScore >= 78) {
    grade = "A+ • BLINDÉ";
    verdictColor = "#00e676";
  } else if (auditScore >= 64) {
    grade = "B+ • ÉQUILIBRÉ";
    verdictColor = "#00e5ff";
  } else if (auditScore >= 48) {
    grade = "C • RISQUÉ";
    verdictColor = "#ffb300";
  } else {
    grade = "D • DANGER ÉLEVÉ";
    verdictColor = "#ff5252";
  }

  return {
    auditScore,
    grade,
    verdictColor,
    survivalPct,
    legs: inspected,
    weakestLink,
  };
}

/**
 * Parse un texte copié-collé depuis 1xBet / Premier Bet / Sportcash / WhatsApp
 * Ex:
 *   PSG - Marseille
 *   Real Madrid vs Barcelone
 * et construit automatiquement un Coupon IA audité !
 */
export function parseExternalTicketText(rawText = "", modelState) {
  const lines = String(rawText)
    .split(/\r?\n|;|\|/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4);

  const builtItems = [];
  const seenPairs = new Set();

  for (const line of lines) {
    const teams = extractTeamsFromQuestion(line);
    if (teams.length >= 2) {
      const key = `${teams[0]}__${teams[1]}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);

      const pred = computeFullPrediction(teams[0], teams[1], "ucl", modelState, null);
      // Si l'utilisateur n'a pas précisé la cote/marché, simuler un pari 1X2 classique pour que l'audit révèle les pièges
      const maxIdx = pred.probs.indexOf(Math.max(...pred.probs));
      const default1X2Market = pred.markets?.[maxIdx] || pred.recommendedMarket;

      builtItems.push({
        id: Date.now() + builtItems.length * 31 + Math.floor(Math.random() * 99),
        home: pred.home,
        away: pred.away,
        league: "ucl",
        probs: pred.probs,
        selectedMarket: {
          ...default1X2Market,
          bookOdd: Number(default1X2Market.marketOdd || 1.65),
        },
      });
    }
  }

  return builtItems;
}
