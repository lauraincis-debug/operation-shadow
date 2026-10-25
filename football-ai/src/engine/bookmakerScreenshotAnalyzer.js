// ============================================================================
// SCANNER DE CAPTURES BOOKMAKER v6.4 Certifiée Intégrale (BETCLIC • 1XBET • WINAMAX • SPORTCASH)
// -> ANALYSE TOUTES LES OPTIONS DE PARIS PROPOSÉES SUR L'IMAGE
// -> SORT UN SEUL « PARI DÉFINITIF » MATHÉMATIQUEMENT OPTIMAL (OU NO-BET STRICT)
// ============================================================================

import { CLUBS_DB, canonicalTeamName, normalizeKey } from "../data/clubs.js";
import { computeFullPrediction, rebuildModelState } from "./predictor.js";
import { computeProMatchMarkets } from "./proMarketsEngine.js";
import { predictOmniSportMatch } from "./omniSportEngine.js";

let __defaultPriorModel = null;
function getDefaultModelState() {
  if (!__defaultPriorModel) {
    __defaultPriorModel = rebuildModelState([]);
  }
  return __defaultPriorModel;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Détecte automatiquement le bookmaker présent sur la capture d'écran
 */
export function detectBookmakerBrand(rawText = "") {
  const t = String(rawText || "").toLowerCase();
  if (t.includes("betclic") || t.includes("mycombi") || t.includes("cote boost")) return "Betclic";
  if (t.includes("winamax") || t.includes("my match")) return "Winamax";
  if (t.includes("parions") || t.includes("fdj")) return "ParionsSport";
  if (t.includes("unibet")) return "Unibet";
  if (t.includes("1xbet") || t.includes("1x")) return "1xBet";
  if (t.includes("sportcash") || t.includes("lonaci")) return "Sportcash CI";
  if (t.includes("melbet")) return "Melbet";
  if (t.includes("bet365")) return "Bet365";
  return "Bookmaker détecté";
}

/**
 * Extrait toutes les cotes décimales valides (ex: 1,52 ou 1.52) d'une ligne de capture Betclic
 */
function extractOddsFromString(line) {
  const matches = [];
  const rx = /(?:^|[^\d.,])([1-9]\d?(?:[.,]\d{2}))(?=$|[^\d])/g;
  let m;
  while ((m = rx.exec(line)) !== null) {
    const val = parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(val) && val >= 1.03 && val <= 45) {
      matches.push(Math.round(val * 100) / 100);
    }
  }
  return matches;
}

/**
 * Identifie les deux équipes/joueurs présents dans le texte OCR de la capture Betclic
 */
export function detectTeamsFromOcrText(rawText = "", liveMatches = []) {
  const cleanText = String(rawText || "");
  const normFull = normalizeKey(cleanText);

  // 1. Chercher en priorité un match réel du calendrier Live / Aujourd'hui / Demain
  for (const m of liveMatches) {
    const hKey = normalizeKey(m.home);
    const aKey = normalizeKey(m.away);
    const hRaw = normalizeKey(m.homeRaw || "");
    const aRaw = normalizeKey(m.awayRaw || "");
    const hasHome =
      (hKey.length >= 4 && normFull.includes(hKey)) ||
      (hRaw.length >= 4 && normFull.includes(hRaw));
    const hasAway =
      (aKey.length >= 4 && normFull.includes(aKey)) ||
      (aRaw.length >= 4 && normFull.includes(aRaw));
    if (hasHome && hasAway) {
      return {
        home: m.home,
        away: m.away,
        sport: m.sport || "soccer",
        league: m.league || "ucl",
        liveMatch: m,
      };
    }
  }

  // 2. Chercher dans les 167 clubs & sélections calibrés en respectant l'ordre d'apparition sur l'image !
  const foundClubs = [];
  for (const club of CLUBS_DB) {
    const terms = [club.name, ...(club.aliases || [])].filter((s) => s.length >= 3);
    let bestPos = Infinity;
    for (const term of terms) {
      const k = normalizeKey(term);
      if (k.length < 3) continue;
      // Exiger frontière de mot sur les acronymes courts (psg, om, ol)
      if (k.length <= 3) {
        const wordRx = new RegExp(`\\b${k}\\b`, "i");
        const hit = wordRx.exec(cleanText.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
        if (hit && hit.index < bestPos) bestPos = hit.index;
      } else {
        const idx = normFull.indexOf(k);
        if (idx >= 0 && idx < bestPos) bestPos = idx;
      }
    }
    if (bestPos < Infinity) {
      foundClubs.push({ club, pos: bestPos });
    }
  }

  foundClubs.sort((a, b) => a.pos - b.pos);
  const uniqueClubs = [];
  for (const item of foundClubs) {
    if (!uniqueClubs.some((u) => u.club.name === item.club.name)) {
      uniqueClubs.push(item);
    }
  }

  if (uniqueClubs.length >= 2) {
    return {
      home: uniqueClubs[0].club.name,
      away: uniqueClubs[1].club.name,
      sport: "soccer",
      league: uniqueClubs[0].club.leagues?.[0] || uniqueClubs[0].club.league || "ucl",
      liveMatch: null,
    };
  }

  // Inférence de discipline réelle sur vocabulaire de la capture (zéro assimilation abusive au football)
  const inferredSport = /\b(atp|wta|jeux|sets?|tie-?break|grand chelem)\b/i.test(cleanText)
    ? "tennis"
    : /\b(nba|euroleague|wnba|quart-temps|rebonds?)\b|(?:plus|moins|[+-])\s*(?:de\s*)?1[5-9]\d[.,]5|(?:plus|moins|[+-])\s*(?:de\s*)?2\d\d[.,]5/i.test(
          cleanText
        )
      ? "basketball"
      : /\b(nfl|touchdowns?|yards?)\b/i.test(cleanText)
        ? "football_us"
        : /\b(nhl|tiers-temps|palet)\b/i.test(cleanText)
          ? "hockey"
          : /\b(mlb|manches?|home\s*run)\b/i.test(cleanText)
            ? "baseball"
            : /\b(ufc|mma|octogone|rounds?)\b/i.test(cleanText)
              ? "mma"
              : "soccer";

  // 3. Fallback : motif "Équipe A - Équipe B" ou "Équipe A vs Équipe B" en haut d'écran Betclic
  const lines = cleanText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 5);
  for (const line of lines.slice(0, 12)) {
    const vsMatch = line.match(/^([A-Za-zÀ-ÿ0-9 .'-]{3,28})\s*(?:\bvs\.?\b|[-–—/])\s*([A-Za-zÀ-ÿ0-9 .'-]{3,28})$/i);
    if (vsMatch) {
      const hName = canonicalTeamName(vsMatch[1].trim());
      const hClub = resolveClub(hName);
      return {
        home: hName,
        away: canonicalTeamName(vsMatch[2].trim()),
        sport: hClub ? "soccer" : inferredSport,
        league: hClub?.leagues?.[0] || hClub?.league || "ucl",
        liveMatch: null,
      };
    }
  }

  return null;
}

/**
 * Parseur intelligent multi-formats (Betclic, Winamax, 1xBet, Sportcash, ParionsSport) :
 * transforme le texte OCR brut d'une capture d'écran en options structurées `{ kind, line, label, bookOdd }`.
 */
export function parseBookmakerMarketsFromText(rawText = "", homeTeam = "", awayTeam = "") {
  const autoTeams = (!homeTeam || !awayTeam) ? detectTeamsFromOcrText(rawText, []) : null;
  homeTeam = homeTeam || autoTeams?.home || "Domicile";
  awayTeam = awayTeam || autoTeams?.away || "Extérieur";
  const options = [];
  const addOpt = (kind, label, bookOdd, line = null) => {
    const odd = Math.round(Number(bookOdd) * 100) / 100;
    if (!Number.isFinite(odd) || odd < 1.03 || odd > 40) return;
    if (options.some((o) => o.kind === kind && o.line === line)) return;
    options.push({ kind, line, label, bookOdd: odd });
  };

  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1] || "";
    const next2 = lines[i + 2] || "";
    const next3 = lines[i + 3] || "";
    const low = cur.toLowerCase();
    const curOdds = extractOddsFromString(cur);
    const windowOdds = [
      ...curOdds,
      ...extractOddsFromString(next),
      ...extractOddsFromString(next2),
      ...extractOddsFromString(next3),
    ];

    // 1. Résultat du match (1 N 2 sur 1 à 3 lignes consécutives façon Betclic / Winamax / 1xBet)
    if (
      /r[eé]sultat du match|issue du match|\b1\s*[x×n]\s*2\b|vainqueur du match/i.test(cur) &&
      windowOdds.length >= 2
    ) {
      if (windowOdds.length >= 3) {
        addOpt("1", `Victoire ${homeTeam} (1)`, windowOdds[0]);
        addOpt("N", `Match Nul (N)`, windowOdds[1]);
        addOpt("2", `Victoire ${awayTeam} (2)`, windowOdds[2]);
      } else {
        addOpt("1", `Victoire ${homeTeam}`, windowOdds[0]);
        addOpt("2", `Victoire ${awayTeam}`, windowOdds[1]);
      }
      continue;
    }

    // 2. Double Chance (1N / 1X, N2 / X2, 12 — y compris format français Betclic "Paris SG ou Nul 1,24" / "Paris SG ou Marseille 1,22" / "Nul ou Marseille 2,25")
    if (/double chance/i.test(cur) && windowOdds.length >= 3) {
      addOpt("1X", `Double Chance ${homeTeam} ou Nul (1N)`, windowOdds[0]);
      addOpt("12", `Double Chance ${homeTeam} ou ${awayTeam} (12)`, windowOdds[1]);
      addOpt("X2", `Double Chance Nul ou ${awayTeam} (N2)`, windowOdds[2]);
      continue;
    }
    const normCur = normalizeKey(cur);
    const homePrefix = normalizeKey(homeTeam).slice(0, 5);
    const awayPrefix = normalizeKey(awayTeam).slice(0, 5);
    const mentionsHome = homePrefix.length >= 2 && normCur.includes(homePrefix);
    const mentionsAway = awayPrefix.length >= 2 && normCur.includes(awayPrefix);
    if (
      curOdds.length >= 1 &&
      ((mentionsHome && mentionsAway && /\b(ou|or)\b|\//i.test(cur)) ||
        /\bdouble\s*chance\s*12\b|^\s*12\b/i.test(low))
    ) {
      addOpt("12", `${homeTeam} ou ${awayTeam} (12)`, curOdds[curOdds.length - 1]);
      continue;
    }
    if ((/\b(1n|1x)\b/i.test(low) || /\bou\s+nul\b/i.test(low)) && curOdds.length >= 1) {
      addOpt("1X", `${homeTeam} ou Nul (1N)`, curOdds[curOdds.length - 1]);
      continue;
    }
    if ((/\b(n2|x2)\b/i.test(low) || /\bnul\s+ou\b/i.test(low)) && curOdds.length >= 1) {
      addOpt("X2", `Nul ou ${awayTeam} (N2)`, curOdds[curOdds.length - 1]);
      continue;
    }

    // 3. Les 2 équipes marquent (BTTS Oui / Non — format Betclic côte à côte ou ligne par ligne)
    if (/les 2 [eé]quipes marquent|but pour les 2|btts|les deux [eé]quipes marquent/i.test(cur)) {
      if (windowOdds.length >= 2) {
        addOpt("BTTS_Y", "Les 2 équipes marquent : Oui", windowOdds[0]);
        addOpt("BTTS_N", "Les 2 équipes marquent : Non", windowOdds[1]);
      }
      continue;
    }
    if (/^\s*oui\b/i.test(cur) && curOdds.length === 1 && /marquent/i.test(lines[i - 1] || "")) {
      addOpt("BTTS_Y", "Les 2 équipes marquent : Oui", curOdds[0]);
    }
    if (/^\s*non\b/i.test(cur) && curOdds.length === 1 && /marquent|oui/i.test(lines[i - 1] || "")) {
      addOpt("BTTS_N", "Les 2 équipes marquent : Non", curOdds[0]);
    }

    // 4. Plus / Moins de X,5 Buts ou Points (ex Betclic : "+ de 1,5 1,28 - de 1,5 3,35" ou "Plus de 2,5 buts 1.78")
    const ouPairRx = /[+pP](?:lus)?\s*(?:de\s*)?(\d+[.,]5)\s*(?:buts?|pts?|points?)?\s*([1-9]\d?[.,]\d{2})\s*[-mM](?:oins)?\s*(?:de\s*)?\1?\s*(?:buts?|pts?|points?)?\s*([1-9]\d?[.,]\d{2})/;
    const ouPair = cur.match(ouPairRx);
    if (ouPair) {
      const threshold = parseFloat(ouPair[1].replace(",", "."));
      addOpt(
        "OVER",
        `Plus de ${threshold} ${threshold > 12 ? "Points" : "Buts"}`,
        parseFloat(ouPair[2].replace(",", ".")),
        threshold
      );
      addOpt(
        "UNDER",
        `Moins de ${threshold} ${threshold > 12 ? "Points" : "Buts"}`,
        parseFloat(ouPair[3].replace(",", ".")),
        threshold
      );
      continue;
    }

    const overSingle = cur.match(/(?:plus\s*de|\+\s*(?:de\s*)?|over\s*)(\d+[.,]5)\s*(?:buts?|corners?|pts?|points?)?/i);
    if (overSingle && curOdds.length >= 1) {
      const th = parseFloat(overSingle[1].replace(",", "."));
      const isCorner = /corner/i.test(cur);
      const isHt = /mi-temps|1re?\s*p[eé]riode|mt\b/i.test(cur);
      if (isCorner) {
        addOpt("CORNERS_OVER", `Plus de ${th} Corners`, curOdds[curOdds.length - 1], th);
      } else if (isHt) {
        addOpt("HT_OVER", `Plus de ${th} But en 1re Mi-Temps`, curOdds[curOdds.length - 1], th);
      } else {
        addOpt("OVER", `Plus de ${th} ${th > 12 ? "Points" : "Buts"}`, curOdds[curOdds.length - 1], th);
      }
      if (curOdds.length >= 2 && /moins|-/i.test(cur)) {
        addOpt("UNDER", `Moins de ${th} ${th > 12 ? "Points" : "Buts"}`, curOdds[1], th);
      }
      continue;
    }

    const underSingle = cur.match(/(?:moins\s*de|-\s*de\s*|under\s*)(\d+[.,]5)\s*(?:buts?|pts?|points?)?/i);
    if (underSingle && curOdds.length >= 1) {
      const th = parseFloat(underSingle[1].replace(",", "."));
      addOpt("UNDER", `Moins de ${th} ${th > 12 ? "Points" : "Buts"}`, curOdds[curOdds.length - 1], th);
      continue;
    }

    // 5. Ligne directe "Nom Équipe + Cote" (ex Betclic boutons : "Paris SG 1,48", "Nul 4,50", "Marseille 6,20")
    if (curOdds.length === 1) {
      if (/\bnul\b|\bmatch nul\b|\bdraw\b/i.test(cur)) {
        addOpt("N", "Match Nul (N)", curOdds[0]);
      } else if (normalizeKey(cur).includes(normalizeKey(homeTeam).slice(0, 5))) {
        addOpt("1", `Victoire ${homeTeam} (1)`, curOdds[0]);
      } else if (normalizeKey(cur).includes(normalizeKey(awayTeam).slice(0, 5))) {
        addOpt("2", `Victoire ${awayTeam} (2)`, curOdds[0]);
      }
    }
  }

  // Fallback intelligent si les 3 premières cotes isolées d'un écran Betclic sont les 3 boutons 1 - N - 2
  if (options.length === 0) {
    const allOdds = extractOddsFromString(rawText);
    if (allOdds.length >= 3) {
      addOpt("1", `Victoire ${homeTeam} (1)`, allOdds[0]);
      addOpt("N", "Match Nul (N)", allOdds[1]);
      addOpt("2", `Victoire ${awayTeam} (2)`, allOdds[2]);
    } else if (allOdds.length === 2) {
      addOpt("1", `Victoire ${homeTeam}`, allOdds[0]);
      addOpt("2", `Victoire ${awayTeam}`, allOdds[1]);
    }
  }

  options.bookmakerName = detectBookmakerBrand(rawText);
  options.homeTeam = homeTeam;
  options.awayTeam = awayTeam;
  options.options = options;
  return options;
}

/**
 * Calcule la VRAIE probabilité Poisson/Dixon-Coles ou Omni-Sport exacte pour n'importe quelle option
 * extraite d'une capture d'écran Betclic, puis élit UN SEUL « PARI DÉFINITIF » !
 */
export function evaluateScreenshotMarketsAndPickDefinitiveBet({
  home,
  away,
  homeTeam,
  awayTeam,
  sport = "soccer",
  league = "ucl",
  bookmakerName = "Betclic",
  extractedOptions,
  options,
  modelState,
  liveMatch = null,
  videoInsight = null,
  bankrollCapital = 50000,
  currency = "XOF",
}) {
  home = canonicalTeamName(home || homeTeam || "PSG");
  away = canonicalTeamName(away || awayTeam || "Marseille");
  const normalizedInputOpts = (extractedOptions || options || []).map((o) => ({
    ...o,
    kind: o.kind || o.code || "1",
    code: o.code || o.kind || "1",
    bookOdd: Number(o.bookOdd ?? o.odd ?? 1.5),
  }));
  extractedOptions = normalizedInputOpts;
  modelState = modelState || getDefaultModelState();
  const isSoccer = !sport || sport === "soccer";

  const safeVideoBoost =
    videoInsight &&
    videoInsight.targetHome &&
    videoInsight.targetAway &&
    normalizeKey(videoInsight.targetHome) === normalizeKey(home) &&
    normalizeKey(videoInsight.targetAway) === normalizeKey(away)
      ? videoInsight
      : null;

  let pred = null;
  let proMkts = null;
  if (isSoccer) {
    pred = computeFullPrediction(home, away, league, modelState, null, {
      videoBoost: safeVideoBoost,
      liveIntel: liveMatch
        ? {
            homeForm: liveMatch.homeForm,
            awayForm: liveMatch.awayForm,
            homeRecord: liveMatch.homeRecord,
            awayRecord: liveMatch.awayRecord,
          }
        : undefined,
    });
    proMkts = computeProMatchMarkets(pred);
  } else {
    pred = predictOmniSportMatch({
      ...(liveMatch || {}),
      sport,
      home,
      away,
      league,
    });
  }

  const totalXg = isSoccer
    ? pred.xg.home + pred.xg.away
    : Number(pred.expectedTotal ?? (pred.xg.home + pred.xg.away) ?? 220);

  // Écart-type Gaussien calibré par sport (NBA, NFL, Tennis Jeux, NHL, MLB, MMA)
  const SPORT_TOTAL_SD = {
    basketball: 16.5,
    football_us: 13.2,
    tennis: 4.5,
    baseball: 3.5,
    hockey: 2.2,
    mma: 1.1,
  };
  const normalCdf = (z) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
    const prob =
      d *
      t *
      (0.31938153 +
        t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t))));
    return z >= 0 ? 1 - prob : prob;
  };

  // Probabilité cumulée Poisson P(Goals > line) exacte pour n'importe quel palier Betclic (0.5, 1.5, 2.5, 3.5, 4.5)
  const poissonOverProb = (lambdaTotal, threshold) => {
    const maxK = Math.floor(threshold);
    let cdf = 0;
    let term = Math.exp(-lambdaTotal);
    for (let k = 0; k <= maxK; k++) {
      if (k > 0) term = (term * lambdaTotal) / k;
      cdf += term;
    }
    return clamp(1 - cdf, 0.03, 0.97);
  };

  const getTrueProbForOption = (opt) => {
    const p1 = pred.rawProbs?.[0] ?? pred.probs[0] / 100;
    const pN = pred.rawProbs?.[1] ?? pred.probs[1] / 100;
    const p2 = pred.rawProbs?.[2] ?? pred.probs[2] / 100;
    const bttsTrue =
      pred.goals?.bttsYes ??
      (pred.goals?.bttsYesPct !== undefined ? pred.goals.bttsYesPct / 100 : 0.5);

    switch (String(opt.kind || opt.code || "").toUpperCase()) {
      case "1":
      case "ML_1":
        return clamp(p1, 0.02, 0.98);
      case "N":
      case "X":
        return isSoccer ? clamp(pN, 0.03, 0.65) : 0.01;
      case "2":
      case "ML_2":
        return clamp(p2, 0.02, 0.98);
      case "1X":
      case "1N":
        return clamp(p1 + pN, 0.04, 0.98);
      case "X2":
      case "N2":
        return clamp(pN + p2, 0.04, 0.98);
      case "12":
        return clamp(p1 + p2, 0.04, 0.98);
      case "BTTS_Y":
      case "BTTS_YES":
        return clamp(bttsTrue, 0.05, 0.95);
      case "BTTS_N":
      case "BTTS_NO":
        return clamp(1 - bttsTrue, 0.05, 0.95);
      case "OVER": {
        if (!isSoccer) {
          const sd = SPORT_TOTAL_SD[sport] || 12.0;
          const line = Number(opt.line ?? totalXg);
          return clamp(normalCdf((totalXg - line) / sd), 0.04, 0.96);
        }
        if (opt.line === 1.5 && pred.goals?.over15 !== undefined) return clamp(pred.goals.over15, 0.03, 0.97);
        if (opt.line === 2.5 && pred.goals?.over25 !== undefined) return clamp(pred.goals.over25, 0.03, 0.97);
        if (opt.line === 3.5 && pred.goals?.over35 !== undefined) return clamp(pred.goals.over35, 0.03, 0.97);
        return poissonOverProb(totalXg, opt.line ?? 2.5);
      }
      case "UNDER": {
        if (!isSoccer) {
          const sd = SPORT_TOTAL_SD[sport] || 12.0;
          const line = Number(opt.line ?? totalXg);
          return clamp(1 - normalCdf((totalXg - line) / sd), 0.04, 0.96);
        }
        if (opt.line === 1.5 && pred.goals?.over15 !== undefined) return clamp(1 - pred.goals.over15, 0.03, 0.97);
        if (opt.line === 2.5 && pred.goals?.under25 !== undefined) return clamp(pred.goals.under25, 0.03, 0.97);
        if (opt.line === 3.5 && pred.goals?.over35 !== undefined) return clamp(1 - pred.goals.over35, 0.03, 0.97);
        return clamp(1 - poissonOverProb(totalXg, opt.line ?? 2.5), 0.03, 0.97);
      }
      case "CORNERS_OVER": {
        const expCorners = proMkts?.corners?.total || 9.8;
        return poissonOverProb(expCorners, opt.line ?? 8.5);
      }
      case "HT_OVER": {
        return poissonOverProb(totalXg * 0.44, opt.line ?? 0.5);
      }
      default:
        return 0.5;
    }
  };

  const analyzedOptions = extractedOptions.map((opt, idx) => {
    const trueProb = getTrueProbForOption(opt);
    const trueProbPct = Math.round(trueProb * 1000) / 10;
    const impliedProbPct = Math.round((100 / opt.bookOdd) * 10) / 10;
    const fairOdd = Math.round((1 / trueProb) * 100) / 100;
    const evPct = Math.round((trueProb * opt.bookOdd - 1) * 1000) / 10;
    const b = Math.max(0.02, opt.bookOdd - 1);
    const rawKelly = (b * trueProb - (1 - trueProb)) / b;
    const quarterKellyPct = rawKelly > 0 ? Math.min(0.05, Math.max(0.005, rawKelly * 0.25)) : 0;
    const recommendedStake =
      quarterKellyPct <= 0
        ? 0
        : currency === "EUR"
          ? Math.max(1, Math.round(bankrollCapital * quarterKellyPct * 10) / 10)
          : Math.max(200, Math.round((bankrollCapital * quarterKellyPct) / 100) * 100);

    // Score décisionnel définitif : exige à la fois une vraie fiabilité (>= 52%) ET une Value réelle !
    const isLottoTrap = trueProb < 0.46;
    const isMicroOddTrap = opt.bookOdd < 1.14 && evPct < 1.5;
    let rankScore = evPct * 1.45 + (trueProbPct - 50) * 0.65;
    if (isLottoTrap) rankScore -= 28;
    if (isMicroOddTrap) rankScore -= 18;
    if (evPct < 0) rankScore -= 15;

    let statusTag = "⚪ Cote juste";
    if (evPct >= 3 && !isLottoTrap) statusTag = "💎 VALUE BET CERTIFIÉE";
    else if (evPct > 0 && trueProb >= 0.55) statusTag = "✅ BONNE OPTION";
    else if (isLottoTrap) statusTag = "⚠️ LOTERIE RISQUÉE";
    else if (evPct <= -4) statusTag = "🚫 COTE ÉCRASÉE (PIÈGE)";

    return {
      id: `opt-${idx}-${opt.kind}-${opt.line ?? ""}`,
      ...opt,
      rawLabel: opt.rawLabel || opt.label,
      canonicalLabel: opt.canonicalLabel || opt.label,
      bookmakerOdd: opt.bookOdd,
      trueProb,
      trueProbPct,
      impliedProbPct,
      fairOdd,
      evPct,
      quarterKellyPct: Math.round(quarterKellyPct * 1000) / 10,
      recommendedStake,
      isLottoTrap,
      rankScore: Math.round(rankScore * 10) / 10,
      statusTag,
    };
  });

  analyzedOptions.sort((a, b) => b.rankScore - a.rankScore);

  const topCandidate = analyzedOptions[0] || null;
  // Règle d'Or Anti-Perte : si MÊME la meilleure option du bookmaker est à EV fortement négative (<-2.5%)
  // ou probabilité trop faible (<46%), on refuse de piéger l'utilisateur -> NO-BET STRICT !
  const isApprovedDefinitiveBet =
    Boolean(topCandidate) &&
    topCandidate.trueProb >= 0.48 &&
    topCandidate.evPct >= -1.5;

  const rejectedSummary = analyzedOptions
    .slice(1)
    .map(
      (o) =>
        `${o.label} (@${o.bookOdd.toFixed(2)} → IA ${o.trueProbPct}%, EV ${o.evPct >= 0 ? "+" : ""}${o.evPct}%)`
    );

  const verdictExplanation = isApprovedDefinitiveBet
    ? `Parmi les ${analyzedOptions.length} option(s) proposées par ${bookmakerName}, « ${topCandidate.label} » à @${topCandidate.bookOdd.toFixed(2)} offre le meilleur couple sécurité/rentabilité mathématique : probabilité réelle IA de ${topCandidate.trueProbPct}% contre ${topCandidate.impliedProbPct}% implicite chez ${bookmakerName} (Espérance ${topCandidate.evPct >= 0 ? "+" : ""}${topCandidate.evPct}%, cote juste IA @${topCandidate.fairOdd.toFixed(2)}).`
    : `Protection du capital activée : sur les ${analyzedOptions.length} option(s) lues sur cette capture ${bookmakerName}, la marge du bookmaker écrase toutes les cotes (meilleure option : ${topCandidate ? `${topCandidate.label} @${topCandidate.bookOdd.toFixed(2)}, EV ${topCandidate.evPct}%` : "aucune"}). Ne misez pas à perte !`;

  return {
    ok: true,
    bookmakerName,
    home,
    homeTeam: home,
    away,
    awayTeam: away,
    sport,
    league,
    expectedSummary: isSoccer
      ? `Modèle Hybride Dixon-Coles + Elo : ${home} ${pred.xg.home} xG — ${pred.xg.away} xG ${away} (${pred.probs[0]}% / ${pred.probs[1]}% / ${pred.probs[2]}%)`
      : `Modèle Omni-Sport : ${home} ${pred.probs[0]}% — ${pred.probs[2]}% ${away}`,
    analyzedOptions,
    evaluatedOptions: analyzedOptions,
    hasApprovedBet: isApprovedDefinitiveBet,
    definitiveBet: isApprovedDefinitiveBet ? topCandidate : null,
    bestAvailableEvenIfNegative: topCandidate,
    noBetReason: isApprovedDefinitiveBet ? null : verdictExplanation,
    verdictHeadline: isApprovedDefinitiveBet
      ? `🏆 PARI DÉFINITIF RECOMMANDÉ SUR ${bookmakerName.toUpperCase()} : ${topCandidate.label} @ ${topCandidate.bookOdd.toFixed(2)}`
      : `🛑 VERDICT DÉFINITIF : PASSER SON TOUR SUR CETTE CAPTURE ${bookmakerName.toUpperCase()} (0 ${currency === "EUR" ? "€" : "FCFA"})`,
    verdictExplanation,
    rejectedSummary,
  };
}

/**
 * Pré-traitement d'image haute netteté (agrandissement + contraste adaptatif) pour captures mobiles Betclic
 */
async function preprocessScreenshotForOcr(imageFileOrBlob) {
  if (typeof document === "undefined") return imageFileOrBlob;
  const bitmap = await createImageBitmap(imageFileOrBlob);
  const scale = bitmap.width < 1100 ? 2 : 1;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width * scale;
  canvas.height = bitmap.height * scale;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  // Renforcement léger du contraste texte blanc/noir sur boutons rouges/gris Betclic
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const contrasted = clamp((lum - 128) * 1.45 + 128, 0, 255);
    d[i] = contrasted;
    d[i + 1] = contrasted;
    d[i + 2] = contrasted;
  }
  ctx.putImageData(imgData, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || imageFileOrBlob), "image/png");
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      resolve(res.includes(",") ? res.split(",")[1] : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Extraction Vision IA Multimodale (si clé Gemini / OpenAI configurée) + Fallback automatique OCR local `tesseract.js` !
 */
export async function extractScreenshotDataFromImage(
  imageFile,
  liveMatches = [],
  onProgress = () => {},
  visionAuth = {}
) {
  const explicitKeyArg = typeof onProgress === "string" ? onProgress : "";
  const safeProgress = typeof onProgress === "function" ? onProgress : () => {};
  const authObj =
    typeof visionAuth === "string"
      ? { geminiApiKey: visionAuth }
      : visionAuth || {};

  safeProgress(12, "Préparation de la capture d'écran Bookmaker...");

  // 1. Si une clé Gemini Vision est disponible, extraction JSON multimodale ultra-précise en < 2s (cascade 2.5 -> 2.0)
  const geminiKey =
    explicitKeyArg ||
    authObj.geminiKey ||
    authObj.geminiApiKey ||
    (typeof localStorage !== "undefined"
      ? (() => {
          try {
            const memV4 = JSON.parse(localStorage.getItem("cloe_ultra_personal_memory_v4") || "{}");
            if (memV4.llmProvider === "gemini" && memV4.llmApiKey) return memV4.llmApiKey;
            const memV5 = JSON.parse(localStorage.getItem("cloe_standalone_memory_v5") || "{}");
            if (memV5.llmProvider === "gemini" && memV5.llmApiKey) return memV5.llmApiKey;
            const rawJavis = localStorage.getItem("javis_gemKey") || "";
            const javisKey = rawJavis.startsWith('"') ? JSON.parse(rawJavis) : rawJavis;
            return javisKey || "";
          } catch {
            return "";
          }
        })()
      : "");

  if (geminiKey && typeof FileReader !== "undefined") {
    try {
      safeProgress(35, "Lecture Vision IA haute précision des cotes & marchés...");
      const b64 = await fileToBase64(imageFile);
      const prompt =
        "Lis cette capture d'écran de paris sportifs (Betclic, Winamax, 1xBet, Sportcash, etc.) et réponds UNIQUEMENT en JSON valide strict sans markdown : " +
        '{"bookmaker":"Betclic","home":"Equipe Domicile ou vide si illisible","away":"Equipe Exterieur ou vide si illisible","sport":"soccer","options":[{"kind":"1|N|2|1X|X2|12|BTTS_Y|BTTS_N|OVER|UNDER|CORNERS_OVER|HT_OVER","line":null,"label":"Intitulé exact","bookOdd":1.75}]} ' +
        "Extrais TOUTES les options de paris et cotes visibles avec exactitude. N'invente AUCUNE équipe ni AUCUNE cote non visible sur l'image (mets \"\" si les noms des équipes ne figurent pas sur l'image).";

      let res = null;
      let usedGeminiModel = "gemini-2.5-flash";
      for (const modelName of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
        usedGeminiModel = modelName;
        const candidateRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": geminiKey.trim(),
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    { inlineData: { mimeType: imageFile.type || "image/png", data: b64 } },
                  ],
                },
              ],
              generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
            }),
          }
        );
        if (candidateRes.ok) {
          res = candidateRes;
          break;
        }
      }

      if (res && res.ok) {
        const json = await res.json();
        const txt = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = JSON.parse(txt.replace(/```json|```/g, "").trim());
        if (parsed && Array.isArray(parsed.options) && parsed.options.length > 0) {
          const rawHome = String(parsed.home || "").trim();
          const rawAway = String(parsed.away || "").trim();
          const hasValidTeams =
            rawHome.length >= 2 &&
            rawAway.length >= 2 &&
            !/equipe domicile|illisible|unknown/i.test(rawHome) &&
            !/equipe exterieur|illisible|unknown/i.test(rawAway);
          const cleanHome = hasValidTeams ? canonicalTeamName(rawHome) : "";
          const cleanAway = hasValidTeams ? canonicalTeamName(rawAway) : "";
          const homeClub = hasValidTeams ? resolveClub(cleanHome) : null;
          safeProgress(100, "Capture analysée avec succès via Vision IA !");
          return {
            engineUsed: `Gemini Vision Multimodale (${usedGeminiModel})`,
            bookmakerName: parsed.bookmaker || "Betclic",
            teamsUnconfirmed: !hasValidTeams,
            detectedMatch: hasValidTeams
              ? {
                  home: cleanHome,
                  away: cleanAway,
                  sport: parsed.sport || "soccer",
                  league: homeClub?.leagues?.[0] || "ucl",
                  liveMatch:
                    liveMatches.find(
                      (m) =>
                        normalizeKey(m.home).includes(normalizeKey(cleanHome)) &&
                        normalizeKey(m.away).includes(normalizeKey(cleanAway))
                    ) || null,
                }
              : null,
            rawText: txt,
            options: parsed.options.map((o) => ({
              kind: o.kind || "1",
              line: o.line ?? null,
              label: o.label,
              bookOdd: Number(o.bookOdd),
            })),
          };
        }
      }
    } catch {
      // Bascule transparente sur le moteur OCR local gratuit Tesseract.js !
    }
  }

  // 2. Moteur OCR 100 % Local & Gratuit (sans aucune clé API !) via Tesseract.js (Français + Anglais)
  safeProgress(28, "OCR Local Haute Précision (Français + Anglais) en cours...");
  const processedBlob = await preprocessScreenshotForOcr(imageFile);
  const Tesseract = await import("tesseract.js");
  const { data } = await Tesseract.recognize(processedBlob, "fra+eng", {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        safeProgress(
          Math.round(30 + m.progress * 65),
          `Lecture optique des cotes Betclic (${Math.round(m.progress * 100)}%)...`
        );
      }
    },
  });

  const rawText = data?.text || "";
  const bookmakerName = detectBookmakerBrand(rawText);
  const detectedMatch = detectTeamsFromOcrText(rawText, liveMatches);
  // SÉCURITÉ FINANCIÈRE STRICTE [AUDIT3-P1-01] : ZÉRO substitution silencieuse par "PSG vs Marseille" !
  const teamsConfirmed = Boolean(detectedMatch?.home && detectedMatch?.away);
  const labelHome = teamsConfirmed ? detectedMatch.home : "Équipe Domicile";
  const labelAway = teamsConfirmed ? detectedMatch.away : "Équipe Extérieur";
  const options = parseBookmakerMarketsFromText(rawText, labelHome, labelAway);

  safeProgress(100, "Lecture optique terminée !");
  return {
    engineUsed: "OCR Local Haute Précision (Tesseract FRA+ENG)",
    bookmakerName,
    teamsUnconfirmed: !teamsConfirmed,
    detectedMatch: teamsConfirmed ? detectedMatch : null,
    rawText,
    options,
  };
}
