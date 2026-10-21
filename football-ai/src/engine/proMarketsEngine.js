import { getSquadStarsForTeam } from "./contextModifiers.js";

/**
 * ⚽ MARCHÉS PROS HAUTE VALEUR :
 * 1) Buteurs Probables (Probabilité Poisson individuelle & juste cote Buteur)
 * 2) Corners Bivariés (Corners Domicile / Extérieur / +8.5 / +9.5 / +10.5)
 * 3) Cartons & Discipline (+3.5 / +4.5 Cartons + Risque Carton Rouge %)
 * 4) Mi-Temps / Scénario Temporel (+0.5 But MT, Score exact MT n°1, Nul MT)
 */

function poissonCumulativeOver(lambda, lineFloor) {
  let sumLeq = 0;
  let term = Math.exp(-lambda);
  for (let k = 0; k <= lineFloor; k++) {
    sumLeq += term;
    term = (term * lambda) / (k + 1);
  }
  return Math.min(0.98, Math.max(0.02, 1 - sumLeq));
}

export function computeProMatchMarkets(pred, matchContext = {}) {
  const xgH = pred?.xg?.home ?? 1.55;
  const xgA = pred?.xg?.away ?? 1.2;
  const totalXg = xgH + xgA;

  // 1. TOP BUTEURS PROBABLES DES 2 ÉQUIPES
  const homeStars = getSquadStarsForTeam(pred.home);
  const awayStars = getSquadStarsForTeam(pred.away);

  const computeTeamScorers = (stars, teamXg, teamName, absentIds = []) => {
    const active = stars.filter((p) => !absentIds.includes(p.id) && p.pos !== "GKP");
    const sumRaw = active.reduce((acc, p) => acc + Math.max(0.05, p.xg90 || 0.12), 0) || 1.2;
    return active.map((p) => {
      const share = Math.min(0.54, Math.max(0.05, (p.xg90 || 0.12) / Math.max(1.05, sumRaw)));
      const playerLambda = teamXg * share;
      const probAnytime = Math.min(0.84, Math.max(0.06, 1 - Math.exp(-playerLambda)));
      const pct = Math.round(probAnytime * 100);
      const marketOdd = Math.max(1.32, Math.round((0.92 / probAnytime) * 100) / 100);
      return {
        id: p.id,
        name: p.name,
        team: teamName,
        pos: p.pos,
        expectedGoals: Math.round(playerLambda * 100) / 100,
        pct,
        marketOdd,
      };
    });
  };

  const allScorers = [
    ...computeTeamScorers(homeStars, xgH, pred.home, matchContext?.absentHomeIds || []),
    ...computeTeamScorers(awayStars, xgA, pred.away, matchContext?.absentAwayIds || []),
  ]
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);

  // 2. CORNERS ATTENDUS (corrélés au volume offensif xG + domination territoriale)
  const homeCornersLambda = Math.round((3.45 + xgH * 1.48) * 10) / 10;
  const awayCornersLambda = Math.round((2.85 + xgA * 1.38) * 10) / 10;
  const totalCornersLambda = Math.round((homeCornersLambda + awayCornersLambda) * 10) / 10;

  const cornersOver85Pct = Math.round(poissonCumulativeOver(totalCornersLambda, 8) * 100);
  const cornersOver95Pct = Math.round(poissonCumulativeOver(totalCornersLambda, 9) * 100);
  const cornersOver105Pct = Math.round(poissonCumulativeOver(totalCornersLambda, 10) * 100);

  // 3. CARTONS JAUNES & ROUGES (intensité ligue + resserrement Elo + derby/K.O.)
  const eloGapAbs = Math.abs(pred?.elo?.diffWithHomeAdv ?? 80);
  const closenessBoost = eloGapAbs < 75 ? 0.55 : eloGapAbs < 150 ? 0.25 : 0;
  const stakesBoost =
    matchContext?.stakes === "derby"
      ? 1.15
      : matchContext?.stakes === "knockout"
        ? 0.55
        : matchContext?.stakes === "rotation"
          ? -0.45
          : 0;
  const leagueCardBase =
    pred.league === "liga" || pred.league === "caf" || pred.league === "world"
      ? 4.45
      : pred.league === "seriea" || pred.league === "ligue1"
        ? 4.05
        : 3.75;

  const expectedCards = Math.max(2.2, Math.round((leagueCardBase + closenessBoost + stakesBoost) * 10) / 10);
  const cardsOver35Pct = Math.round(poissonCumulativeOver(expectedCards, 3) * 100);
  const cardsOver45Pct = Math.round(poissonCumulativeOver(expectedCards, 4) * 100);
  const redCardRiskPct = Math.min(42, Math.max(8, Math.round(expectedCards * 4.4)));

  // 4. MI-TEMPS (44% de la densité xG totale en 1re période)
  const htH = xgH * 0.44;
  const htA = xgA * 0.44;
  const htGoalOver05Pct = Math.round((1 - Math.exp(-(htH + htA))) * 100);
  const htGoalOver15Pct = Math.round(poissonCumulativeOver(htH + htA, 1) * 100);

  // Probabilité Nul à la Mi-Temps (somme k=0..3 de P(H=k)*P(A=k))
  let pHtDraw = 0;
  for (let k = 0; k <= 3; k++) {
    const fact = k <= 1 ? 1 : k === 2 ? 2 : 6;
    const pH = (Math.exp(-htH) * Math.pow(htH, k)) / fact;
    const pA = (Math.exp(-htA) * Math.pow(htA, k)) / fact;
    pHtDraw += pH * pA;
  }
  const htDrawPct = Math.min(68, Math.max(24, Math.round(pHtDraw * 100)));

  return {
    topScorers: allScorers,
    corners: {
      home: homeCornersLambda,
      away: awayCornersLambda,
      total: totalCornersLambda,
      over85Pct: cornersOver85Pct,
      over85Odd: Math.max(1.18, Math.round((94 / cornersOver85Pct) * 100) / 100),
      over95Pct: cornersOver95Pct,
      over95Odd: Math.max(1.25, Math.round((94 / cornersOver95Pct) * 100) / 100),
      over105Pct: cornersOver105Pct,
      over105Odd: Math.max(1.38, Math.round((94 / cornersOver105Pct) * 100) / 100),
    },
    cards: {
      expectedTotal: expectedCards,
      over35Pct: cardsOver35Pct,
      over35Odd: Math.max(1.2, Math.round((94 / cardsOver35Pct) * 100) / 100),
      over45Pct: cardsOver45Pct,
      over45Odd: Math.max(1.32, Math.round((94 / cardsOver45Pct) * 100) / 100),
      redCardRiskPct,
    },
    halfTime: {
      over05Pct: htGoalOver05Pct,
      over05Odd: Math.max(1.18, Math.round((94 / htGoalOver05Pct) * 100) / 100),
      over15Pct: htGoalOver15Pct,
      drawHtPct: htDrawPct,
      drawHtOdd: Math.max(1.55, Math.round((94 / htDrawPct) * 100) / 100),
    },
  };
}
