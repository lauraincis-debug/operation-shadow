import { canonicalTeamName, normalizeKey } from "../data/clubs.js";

// ============================================================================
// OMNI-SPORT LIVE INTERNET HARVESTER & ZERO-HALLUCINATION CONNECTOR v6.4
// 1. 42 endpoints de compétitions sur 7 sports (compteur dérivé du catalogue)
// 2. Cache SWR explicitement marqué comme cache + contrôle d'âge du snapshot
// 3. Dossiers ESPN : H2H, résultats récents, jours de repos et données publiées
// ============================================================================

const API_SETTINGS_STORAGE = "football_ai_server_connectors_v1";
const LEGACY_API_KEYS_STORAGE = "football_ai_external_apis_v3";
const SWR_CACHE_PREFIX = "fai_v6_swr_day_";
const DOSSIER_CACHE = new Map();
const MEMORY_DAY_CACHE = new Map();
let CLOUD_SNAPSHOT_PROMISE = null;

export const LIVE_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const LIVE_FEED_MAX_AGE_MS = 3 * 60 * 1000;
const LIVE_STATUS_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

function parseTimestamp(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

export function isCloudSnapshotFresh(snapshot, now = Date.now(), maxAgeMs = LIVE_SNAPSHOT_MAX_AGE_MS) {
  const generatedAt = parseTimestamp(
    snapshot?.generatedAtIso || snapshot?.generatedAt || snapshot?.updatedAtIso
  );
  if (generatedAt === null) return false;
  const ageMs = now - generatedAt;
  return ageMs >= -CLOCK_SKEW_TOLERANCE_MS && ageMs <= maxAgeMs;
}

export function getCloudSnapshotAgeMs(snapshot, now = Date.now()) {
  const generatedAt = parseTimestamp(
    snapshot?.generatedAtIso || snapshot?.generatedAt || snapshot?.updatedAtIso
  );
  return generatedAt === null ? null : Math.max(0, now - generatedAt);
}

export function isMatchFeedFresh(match, now = Date.now(), maxAgeMs = LIVE_FEED_MAX_AGE_MS) {
  if (
    match?.isRealInternet !== true ||
    match?.isLiveNetwork !== true ||
    match?.isSnapshot === true ||
    match?.isCached === true
  ) {
    return false;
  }
  const verifiedAt = parseTimestamp(match?.statusVerifiedAtIso || match?.fetchedAtIso);
  if (verifiedAt === null) return false;
  const ageMs = now - verifiedAt;
  return ageMs >= -CLOCK_SKEW_TOLERANCE_MS && ageMs <= maxAgeMs;
}

function maxLiveDurationMs(sport = "soccer") {
  const hoursBySport = {
    soccer: 4.5,
    basketball: 4.5,
    football: 6,
    hockey: 4.5,
    baseball: 6.5,
    tennis: 8,
    mma: 8,
  };
  return (hoursBySport[sport] || 5) * 60 * 60 * 1000;
}

/** Un statut « en cours » n'est exploitable que s'il vient d'un flux officiel récent. */
export function isVerifiedCurrentlyLiveMatch(match, now = Date.now()) {
  if (
    !match ||
    match.completed === true ||
    match.state !== "in" ||
    match.isRealInternet !== true ||
    match.isLiveNetwork !== true ||
    match.isSnapshot === true ||
    match.isCached === true ||
    !match.statusVerifiedAtIso ||
    !["ESPN scoreboard", "ESPN event summary", "Football-Data.org"].includes(
      match.statusVerificationSource
    )
  ) {
    return false;
  }
  if (!match.externalId || !match.kickoffIso) return false;

  const kickoff = parseTimestamp(match.kickoffIso);
  if (kickoff === null) return false;
  const sinceKickoff = now - kickoff;
  if (
    sinceKickoff < -CLOCK_SKEW_TOLERANCE_MS ||
    sinceKickoff > maxLiveDurationMs(match.sport)
  ) {
    return false;
  }

  const maxAge = match.statusVerifiedAtIso ? LIVE_STATUS_MAX_AGE_MS : LIVE_FEED_MAX_AGE_MS;
  return isMatchFeedFresh(match, now, maxAge);
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Extrait uniquement la journée demandée, jamais le snapshot multi-jours entier. */
export function getSnapshotMatchesForDate(snapshot, isoDate) {
  const all = [
    ...Object.values(snapshot?.days || {}).flat(),
    ...(Array.isArray(snapshot?.allMatches) ? snapshot.allMatches : []),
  ];
  const seen = new Set();
  return all.filter((match) => {
    if (!match?.externalId || !match?.kickoffIso || localDateKey(match.kickoffIso) !== isoDate) {
      return false;
    }
    if (seen.has(match.externalId)) return false;
    seen.add(match.externalId);
    return true;
  });
}

export const OMNI_SPORT_ENDPOINTS = [
  // ==================== ⚽ FOOTBALL MONDIAL (32 COMPÉTITIONS) ====================
  { sport: "soccer", sportPath: "soccer/uefa.champions", slug: "uefa.champions", leagueId: "ucl", label: "Ligue des Champions 🇪🇺" },
  { sport: "soccer", sportPath: "soccer/uefa.europa", slug: "uefa.europa", leagueId: "europa", label: "Europa League 🟠" },
  { sport: "soccer", sportPath: "soccer/uefa.europa.conf", slug: "uefa.europa.conf", leagueId: "europa", label: "Conference League 🟢" },
  { sport: "soccer", sportPath: "soccer/fra.1", slug: "fra.1", leagueId: "ligue1", label: "Ligue 1 🇫🇷" },
  { sport: "soccer", sportPath: "soccer/fra.2", slug: "fra.2", leagueId: "ligue1", label: "Ligue 2 🇫🇷" },
  { sport: "soccer", sportPath: "soccer/eng.1", slug: "eng.1", leagueId: "premier", label: "Premier League 🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { sport: "soccer", sportPath: "soccer/eng.2", slug: "eng.2", leagueId: "premier", label: "Championship 🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { sport: "soccer", sportPath: "soccer/eng.fa", slug: "eng.fa", leagueId: "premier", label: "FA Cup 🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { sport: "soccer", sportPath: "soccer/eng.league_cup", slug: "eng.league_cup", leagueId: "premier", label: "EFL Cup 🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { sport: "soccer", sportPath: "soccer/esp.1", slug: "esp.1", leagueId: "liga", label: "La Liga 🇪🇸" },
  { sport: "soccer", sportPath: "soccer/esp.copa_del_rey", slug: "esp.copa_del_rey", leagueId: "liga", label: "Copa del Rey 🇪🇸" },
  { sport: "soccer", sportPath: "soccer/ger.1", slug: "ger.1", leagueId: "bundesliga", label: "Bundesliga 🇩🇪" },
  { sport: "soccer", sportPath: "soccer/ger.dfb_pokal", slug: "ger.dfb_pokal", leagueId: "bundesliga", label: "DFB-Pokal 🇩🇪" },
  { sport: "soccer", sportPath: "soccer/ita.1", slug: "ita.1", leagueId: "seriea", label: "Serie A 🇮🇹" },
  { sport: "soccer", sportPath: "soccer/ita.coppa_italia", slug: "ita.coppa_italia", leagueId: "seriea", label: "Coppa Italia 🇮🇹" },
  { sport: "soccer", sportPath: "soccer/por.1", slug: "por.1", leagueId: "ucl", label: "Liga Portugal 🇵🇹" },
  { sport: "soccer", sportPath: "soccer/ned.1", slug: "ned.1", leagueId: "ucl", label: "Eredivisie 🇳🇱" },
  { sport: "soccer", sportPath: "soccer/bel.1", slug: "bel.1", leagueId: "ucl", label: "Pro League 🇧🇪" },
  { sport: "soccer", sportPath: "soccer/sco.1", slug: "sco.1", leagueId: "premier", label: "Premiership 🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
  { sport: "soccer", sportPath: "soccer/tur.1", slug: "tur.1", leagueId: "world", label: "Süper Lig 🇹🇷" },
  { sport: "soccer", sportPath: "soccer/caf.champions", slug: "caf.champions", leagueId: "caf", label: "LDC CAF Afrique 🌍" },
  { sport: "soccer", sportPath: "soccer/caf.nations", slug: "caf.nations", leagueId: "international", label: "CAN / Afrique 🌍" },
  { sport: "soccer", sportPath: "soccer/fifa.world", slug: "fifa.world", leagueId: "international", label: "Coupe du Monde 🌍" },
  { sport: "soccer", sportPath: "soccer/fifa.cwc", slug: "fifa.cwc", leagueId: "world", label: "Mondial des Clubs 🏆" },
  { sport: "soccer", sportPath: "soccer/uefa.nations", slug: "uefa.nations", leagueId: "international", label: "UEFA Nations League 🇪🇺" },
  { sport: "soccer", sportPath: "soccer/ksa.1", slug: "ksa.1", leagueId: "saudi", label: "Saudi Pro League 🇸🇦" },
  { sport: "soccer", sportPath: "soccer/usa.1", slug: "usa.1", leagueId: "world", label: "MLS Amérique 🇺🇸" },
  { sport: "soccer", sportPath: "soccer/mex.1", slug: "mex.1", leagueId: "world", label: "Liga MX 🇲🇽" },
  { sport: "soccer", sportPath: "soccer/bra.1", slug: "bra.1", leagueId: "world", label: "Brasileirão 🇧🇷" },
  { sport: "soccer", sportPath: "soccer/arg.1", slug: "arg.1", leagueId: "world", label: "Liga Argentina 🇦🇷" },
  { sport: "soccer", sportPath: "soccer/conmebol.libertadores", slug: "conmebol.libertadores", leagueId: "world", label: "Copa Libertadores 🌎" },
  { sport: "soccer", sportPath: "soccer/fifa.friendly", slug: "fifa.friendly", leagueId: "international", label: "Matchs Internationaux 🌍" },

  // ==================== 🏀 BASKETBALL ====================
  { sport: "basketball", sportPath: "basketball/nba", slug: "nba", leagueId: "nba", label: "NBA Basketball 🏀" },
  { sport: "basketball", sportPath: "basketball/wnba", slug: "wnba", leagueId: "wnba", label: "WNBA Basketball 🏀" },
  { sport: "basketball", sportPath: "basketball/mens-college-basketball", slug: "ncaab", leagueId: "ncaab", label: "NCAA Basketball 🏀" },

  // ==================== 🎾 TENNIS MONDIAL ====================
  { sport: "tennis", sportPath: "tennis/atp", slug: "atp", leagueId: "atp", label: "Tennis ATP Tour 🎾" },
  { sport: "tennis", sportPath: "tennis/wta", slug: "wta", leagueId: "wta", label: "Tennis WTA Tour 🎾" },

  // ==================== 🏈 FOOTBALL AMÉRICAIN ====================
  { sport: "football", sportPath: "football/nfl", slug: "nfl", leagueId: "nfl", label: "NFL Football US 🏈" },
  { sport: "football", sportPath: "football/college-football", slug: "ncaaf", leagueId: "ncaaf", label: "NCAA Football US 🏈" },

  // ==================== 🏒 HOCKEY SUR GLACE ====================
  { sport: "hockey", sportPath: "hockey/nhl", slug: "nhl", leagueId: "nhl", label: "NHL Hockey 🏒" },

  // ==================== ⚾ BASEBALL ====================
  { sport: "baseball", sportPath: "baseball/mlb", slug: "mlb", leagueId: "mlb", label: "MLB Baseball ⚾" },

  // ==================== 🥊 MMA / UFC ====================
  { sport: "mma", sportPath: "mma/ufc", slug: "ufc", leagueId: "ufc", label: "UFC / MMA 🥊" },
];

export const ESPN_LEAGUE_ENDPOINTS = OMNI_SPORT_ENDPOINTS.filter((e) => e.sport === "soccer");

export function loadExternalApiConfig() {
  const safeConfig = { provider: "auto", autoLearnResults: true };
  try {
    // Supprime toute ancienne clé API qui aurait été enregistrée dans le navigateur.
    localStorage.removeItem(LEGACY_API_KEYS_STORAGE);
    const raw = localStorage.getItem(API_SETTINGS_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw);
      safeConfig.autoLearnResults = parsed?.autoLearnResults !== false;
    }
    localStorage.setItem(API_SETTINGS_STORAGE, JSON.stringify(safeConfig));
  } catch {
    // Le mode public reste utilisable même si le stockage local est indisponible.
  }
  return safeConfig;
}

export function saveExternalApiConfig(cfg = {}) {
  const safeConfig = {
    provider: "auto",
    autoLearnResults: cfg.autoLearnResults !== false,
  };
  try {
    localStorage.setItem(API_SETTINGS_STORAGE, JSON.stringify(safeConfig));
    localStorage.removeItem(LEGACY_API_KEYS_STORAGE);
  } catch {
    // ignore
  }
}

export function getOffsetDateStrings(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return {
    compact: `${yyyy}${mm}${dd}`,
    iso: `${yyyy}-${mm}-${dd}`,
    displayFr: d.toLocaleDateString("fr-FR", {
      weekday: "short",
      day: "2-digit",
      month: "short",
    }),
  };
}

function americanToDecimalOdd(american) {
  if (american === "EVEN" || american === "even") return 2.0;
  const val = Number(String(american || "").replace(/[^\d+-]/g, ""));
  if (Number.isNaN(val) || val === 0) return null;
  const dec = val > 0 ? 1 + val / 100 : 1 + 100 / Math.abs(val);
  return Math.round(dec * 100) / 100;
}

function formatFullVenue(venueObj, fallbackCity = "") {
  if (!venueObj) return { venue: "", venueCity: fallbackCity, venueCountry: "", venueFull: "" };
  const name = venueObj.fullName || venueObj.name || "";
  const city = venueObj.address?.city || fallbackCity || "";
  const country = venueObj.address?.country || venueObj.address?.state || "";
  const parts = [name, city, country].filter(Boolean);
  return {
    venue: name,
    venueCity: city,
    venueCountry: country,
    venueFull: parts.join(", "),
    indoor: Boolean(venueObj.indoor),
    capacity: venueObj.capacity || null,
  };
}

function extractCompetitorLeaders(comp) {
  const out = [];
  for (const side of comp.competitors || []) {
    const teamName =
      side.athlete?.displayName ||
      side.team?.shortDisplayName ||
      side.team?.displayName ||
      "";
    for (const cat of side.leaders || []) {
      const top = cat.leaders?.[0];
      if (top?.athlete?.displayName) {
        out.push({
          team: teamName,
          category: cat.shortDisplayName || cat.displayName || "Leader",
          player: top.athlete.displayName,
          value: top.displayValue || "",
        });
      }
    }
  }
  return out.slice(0, 6);
}

/**
 * Parseur universel ESPN v6 (compatible Football, NBA, NFL, NHL, MLB, Tennis groupings & UFC !)
 */
export function parseOmniEspnEvent(ev, endpointMeta) {
  const results = [];
  const sourceFetchedAtIso = endpointMeta.fetchedAtIso || new Date().toISOString();
  const isLiveNetwork = endpointMeta.isLiveNetwork !== false;
  const statusVerifiedAtIso = endpointMeta.statusVerifiedAtIso ||
    (isLiveNetwork ? sourceFetchedAtIso : null);
  const tournamentTitle = ev.name || ev.shortName || endpointMeta.label;
  const tournamentVenue = ev.venue || null;

  // Tennis utilise ev.groupings[].competitions[], les autres sports ev.competitions[]
  const rawComps = [];
  if (Array.isArray(ev.groupings) && ev.groupings.length > 0) {
    for (const g of ev.groupings) {
      const gLabel = g.grouping?.displayName || "";
      for (const c of g.competitions || []) {
        rawComps.push({ comp: c, subLabel: gLabel });
      }
    }
  } else {
    for (const c of ev.competitions || []) {
      rawComps.push({ comp: c, subLabel: "" });
    }
  }

  for (const { comp, subLabel } of rawComps) {
    const competitors = comp.competitors || [];
    if (competitors.length < 2) continue;

    const homeComp =
      competitors.find((c) => c.homeAway === "home") ||
      competitors.find((c) => c.order === 1) ||
      competitors[0];
    const awayComp =
      competitors.find((c) => c.homeAway === "away") ||
      competitors.find((c) => c.order === 2 && c !== homeComp) ||
      competitors[1];
    if (!homeComp || !awayComp) continue;

    const rawHome =
      homeComp.athlete?.displayName ||
      homeComp.team?.shortDisplayName ||
      homeComp.team?.displayName ||
      "";
    const rawAway =
      awayComp.athlete?.displayName ||
      awayComp.team?.shortDisplayName ||
      awayComp.team?.displayName ||
      "";
    if (!rawHome || !rawAway || /tbd|à déterminer/i.test(`${rawHome} ${rawAway}`)) continue;

    const state = comp.status?.type?.state || "pre";
    const completed = Boolean(comp.status?.type?.completed);
    const statusDetail = comp.status?.type?.shortDetail || "";

    // Gestion scores classiques + sets Tennis (linescores)
    let scoreHome =
      state !== "pre" && homeComp.score !== undefined ? parseInt(homeComp.score, 10) : null;
    let scoreAway =
      state !== "pre" && awayComp.score !== undefined ? parseInt(awayComp.score, 10) : null;
    let setBreakdown = "";

    if (endpointMeta.sport === "tennis" && Array.isArray(homeComp.linescores)) {
      const setsH = homeComp.linescores.map((s) => s.value ?? 0);
      const setsA = (awayComp.linescores || []).map((s) => s.value ?? 0);
      if (setsH.length > 0) {
        let wonH = 0;
        let wonA = 0;
        const pairs = setsH.map((sh, idx) => {
          const sa = setsA[idx] ?? 0;
          if (sh > sa && (sh >= 6 || completed)) wonH++;
          else if (sa > sh && (sa >= 6 || completed)) wonA++;
          return `${sh}-${sa}`;
        });
        setBreakdown = pairs.join(", ");
        if (Number.isNaN(scoreHome) || scoreHome === null) {
          scoreHome = homeComp.winner ? Math.max(wonH, 2) : wonH;
          scoreAway = awayComp.winner ? Math.max(wonA, 2) : wonA;
        }
      }
    } else if (endpointMeta.sport === "mma" && completed) {
      scoreHome = homeComp.winner ? 1 : 0;
      scoreAway = awayComp.winner ? 1 : 0;
    }

    let liveOdds = null;
    const oddsEntry = comp.odds?.[0];
    if (oddsEntry) {
      const o1 = americanToDecimalOdd(oddsEntry.homeTeamOdds?.moneyLine);
      const oN = americanToDecimalOdd(oddsEntry.drawOdds?.moneyLine);
      const o2 = americanToDecimalOdd(oddsEntry.awayTeamOdds?.moneyLine);
      const spread = oddsEntry.spread ?? null;
      const totalLine = oddsEntry.overUnder ?? null;
      if (o1 || oN || o2 || spread !== null || totalLine !== null) {
        liveOdds = {
          provider: oddsEntry.provider?.name || "Market Consensus",
          oddSource: "feed",
          odd1: o1 ? String(o1) : "",
          oddN: oN ? String(oN) : "",
          odd2: o2 ? String(o2) : "",
          details: oddsEntry.details || "",
          spread: spread !== null ? Number(spread) : null,
          totalLine: totalLine !== null ? Number(totalLine) : null,
        };
      }
    }

    const isoRaw = comp.date || ev.date || "";
    const kickoffDate = isoRaw ? new Date(isoRaw) : null;
    const timeStr = kickoffDate
      ? kickoffDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      : "--:--";
    const fullDateFr = kickoffDate
      ? kickoffDate.toLocaleDateString("fr-FR", {
          weekday: "short",
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "";

    const venueInfo = formatFullVenue(comp.venue || tournamentVenue);
    const isSoccer = endpointMeta.sport === "soccer";
    const homeCanon = isSoccer ? canonicalTeamName(rawHome) : rawHome;
    const awayCanon = isSoccer ? canonicalTeamName(rawAway) : rawAway;

    const homeRecObj = homeComp.records || [];
    const awayRecObj = awayComp.records || [];

    results.push({
      externalId: `espn-${comp.id || ev.id}`,
      rawEventId: String(ev.id),
      rawCompId: String(comp.id || ev.id),
      isRealInternet: true,
      isLiveNetwork,
      isCached: endpointMeta.isCached === true,
      isSnapshot: endpointMeta.isSnapshot === true,
      fetchedAtIso: sourceFetchedAtIso,
      ...(statusVerifiedAtIso ? { statusVerifiedAtIso } : {}),
      ...(isLiveNetwork
        ? { statusVerificationSource: endpointMeta.statusVerificationSource || "ESPN scoreboard" }
        : {}),
      source: "ESPN Live API",
      sport: endpointMeta.sport,
      sportPath: endpointMeta.sportPath,
      leagueSlug: endpointMeta.slug,
      league: endpointMeta.leagueId,
      leagueLabel:
        endpointMeta.sport === "tennis" || endpointMeta.sport === "mma"
          ? `${endpointMeta.label} • ${tournamentTitle}${subLabel ? ` (${subLabel})` : ""}`
          : endpointMeta.label,
      homeRaw: rawHome,
      awayRaw: rawAway,
      home: homeCanon,
      away: awayCanon,
      homeLogo: homeComp.team?.logo || homeComp.athlete?.flag?.href || "",
      awayLogo: awayComp.team?.logo || awayComp.athlete?.flag?.href || "",
      homeForm: homeComp.form || "",
      awayForm: awayComp.form || "",
      homeRecord: homeRecObj[0]?.summary || "",
      awayRecord: awayRecObj[0]?.summary || "",
      homeSplitRecord:
        homeRecObj.find((r) => /home|dom/i.test(r.name || r.type || ""))?.summary || "",
      awaySplitRecord:
        awayRecObj.find((r) => /away|road|ext/i.test(r.name || r.type || ""))?.summary || "",
      kickoffIso: isoRaw,
      timeStr,
      dateFr: kickoffDate ? kickoffDate.toLocaleDateString("fr-FR") : "",
      fullDateFr,
      venue: venueInfo.venue,
      venueCity: venueInfo.venueCity,
      venueCountry: venueInfo.venueCountry,
      venueFull: venueInfo.venueFull,
      attendance: comp.attendance || null,
      neutralSite: Boolean(comp.neutralSite),
      leaders: extractCompetitorLeaders(comp),
      setBreakdown,
      state,
      completed,
      statusText:
        state === "in"
          ? `🔴 DIRECT ${statusDetail}`
          : completed
            ? `Terminé${setBreakdown ? ` (${setBreakdown})` : ""}`
            : `🕒 ${timeStr}`,
      scoreHome: Number.isNaN(scoreHome) ? null : scoreHome,
      scoreAway: Number.isNaN(scoreAway) ? null : scoreAway,
      liveOdds,
    });
  }

  return results;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: "no-store", ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchFootballDataForDay(isoDate) {
  try {
    const res = await fetchWithTimeout(
      `/api/football/fixtures?date=${encodeURIComponent(isoDate)}`,
      { cache: "no-store" },
      6500
    );
    if (!res.ok) return null;
    const payload = await res.json();
    const matches = Array.isArray(payload?.matches) ? payload.matches : [];
    return {
      ...payload,
      matches: matches.map((match) => {
        const homeRaw = match.homeRaw || match.home || "";
        const awayRaw = match.awayRaw || match.away || "";
        return {
          ...match,
          homeRaw,
          awayRaw,
          home: canonicalTeamName(homeRaw),
          away: canonicalTeamName(awayRaw),
          sport: "soccer",
          source: "Football-Data.org",
        };
      }),
    };
  } catch {
    return null;
  }
}

export async function fetchApiFootballPlayerStats(match, teamName) {
  if (!match || !String(teamName || "").trim()) {
    return { available: false, matched: false, reason: "Nom d'équipe manquant", players: [] };
  }
  const leagueIds = {
    premier: 39,
    liga: 140,
    bundesliga: 78,
    seriea: 135,
    ligue1: 61,
    ucl: 2,
    europa: 3,
    saudi: 307,
  };
  const kickoff = match.kickoffIso ? new Date(match.kickoffIso) : new Date();
  const season = Number.isFinite(kickoff.getTime()) ? kickoff.getUTCFullYear() : new Date().getUTCFullYear();
  const params = new URLSearchParams({ team_name: String(teamName).trim(), season: String(season) });
  const leagueId = leagueIds[match.league];
  if (leagueId) params.set("league_id", String(leagueId));
  try {
    const response = await fetchWithTimeout(
      `/api/football/player-stats?${params.toString()}`,
      { cache: "no-store" },
      9000
    );
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return {
        available: false,
        matched: false,
        reason: payload?.detail || "Connecteur API-Football non disponible",
        players: [],
      };
    }
    return payload || { available: false, matched: false, players: [] };
  } catch {
    return { available: false, matched: false, reason: "Service de données indisponible", players: [] };
  }
}

async function fetchOmniEspnForDay(offsetDays) {
  const { compact } = getOffsetDateStrings(offsetDays);
  const settled = await Promise.allSettled(
    OMNI_SPORT_ENDPOINTS.map(async (ep) => {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${ep.sportPath}/scoreboard?dates=${compact}`;
      const res = await fetchWithTimeout(url, { cache: "no-store" }, 6500);
      if (!res.ok) throw new Error(`ESPN scoreboard HTTP ${res.status}`);
      const json = await res.json();
      const verifiedAtIso = new Date().toISOString();
      const sourceMeta = {
        ...ep,
        fetchedAtIso: verifiedAtIso,
        statusVerifiedAtIso: verifiedAtIso,
        statusVerificationSource: "ESPN scoreboard",
        isLiveNetwork: true,
      };
      return (json.events || []).flatMap((ev) => parseOmniEspnEvent(ev, sourceMeta));
    })
  );

  const successfulEndpoints = settled.filter((result) => result.status === "fulfilled").length;
  const flat = settled
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);

  const seen = new Set();
  const matches = flat.filter((match) => {
    const key = `${match.sport}__${normalizeKey(match.home)}__${normalizeKey(match.away)}__${match.dateFr}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { matches, successfulEndpoints };
}

function sameFixtureAcrossProviders(a, b) {
  if (!a || !b || (a.sport || "soccer") !== (b.sport || "soccer")) return false;
  const sameTeams =
    normalizeKey(canonicalTeamName(a.homeRaw || a.home)) ===
      normalizeKey(canonicalTeamName(b.homeRaw || b.home)) &&
    normalizeKey(canonicalTeamName(a.awayRaw || a.away)) ===
      normalizeKey(canonicalTeamName(b.awayRaw || b.away));
  if (!sameTeams) return false;
  const kickoffA = parseTimestamp(a.kickoffIso);
  const kickoffB = parseTimestamp(b.kickoffIso);
  return kickoffA !== null && kickoffB !== null
    ? Math.abs(kickoffA - kickoffB) <= 90 * 60 * 1000
    : a.dateFr === b.dateFr;
}

function mergeFootballSources(footballDataMatches = [], espnMatches = []) {
  const usedEspn = new Set();
  const merged = footballDataMatches.map((officialMatch) => {
    const espnIndex = espnMatches.findIndex(
      (match, index) => !usedEspn.has(index) && sameFixtureAcrossProviders(officialMatch, match)
    );
    if (espnIndex < 0) return officialMatch;
    usedEspn.add(espnIndex);
    const espnMatch = espnMatches[espnIndex];
    const primary =
      espnMatch.isLiveNetwork === true && espnMatch.isCached !== true
        ? espnMatch
        : officialMatch;
    const finalScoreAvailable =
      officialMatch.completed === true &&
      typeof officialMatch.scoreHome === "number" &&
      typeof officialMatch.scoreAway === "number";
    return {
      ...primary,
      footballDataExternalId: officialMatch.externalId,
      footballDataStatus: officialMatch.officialStatus || null,
      ...(finalScoreAvailable
        ? {
            completed: true,
            state: "post",
            scoreHome: officialMatch.scoreHome,
            scoreAway: officialMatch.scoreAway,
            statusText: "Terminé — résultat Football-Data.org",
            resultSource: "Football-Data.org",
            statusVerifiedAtIso: officialMatch.statusVerifiedAtIso || primary.statusVerifiedAtIso,
            statusVerificationSource:
              officialMatch.statusVerificationSource || primary.statusVerificationSource,
          }
        : {}),
      source: primary === espnMatch ? "ESPN + Football-Data.org" : "Football-Data.org + ESPN",
    };
  });

  espnMatches.forEach((match, index) => {
    if (!usedEspn.has(index)) merged.push(match);
  });
  return merged;
}

function markScheduleAsUnverified(matches = [], { snapshot = false } = {}) {
  return matches.map((match) => {
    const mustSuppressLive = match.state === "in" && match.completed !== true;
    const { statusVerifiedAtIso, statusVerificationSource, ...rest } = match;
    return {
      ...rest,
      ...(mustSuppressLive
        ? {
            state: "unknown",
            statusText: "Statut Live historique non revalidé — actualisez le flux",
          }
        : {}),
      isLiveNetwork: false,
      isCached: true,
      isSnapshot: snapshot,
      statusVerifiedAtIso: undefined,
      statusVerificationSource: undefined,
    };
  });
}

/**
 * Charge le Snapshot Cloud Vérifié (/live-omni-snapshot.json) généré automatiquement
 * par GitHub Actions depuis Internet (affichage instantané < 20 ms !).
 */
export async function loadCloudVerifiedSnapshot() {
  if (!CLOUD_SNAPSHOT_PROMISE) {
    CLOUD_SNAPSHOT_PROMISE = fetchWithTimeout("./live-omni-snapshot.json", { cache: "no-store" }, 3500)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return CLOUD_SNAPSHOT_PROMISE;
}

/**
 * Lecture synchrone du cache SWR. Un cache n'est jamais présenté comme un flux Live réseau.
 */
export function peekCachedScheduleForOffset(offsetDays = 0) {
  const { iso } = getOffsetDateStrings(offsetDays);
  let cached = MEMORY_DAY_CACHE.get(iso) || null;
  if (!cached) {
    try {
      const raw = localStorage.getItem(SWR_CACHE_PREFIX + iso);
      if (raw) cached = JSON.parse(raw);
    } catch {
      // ignore
    }
  }
  if (!cached?.matches?.length) return null;

  const cachedAt = parseTimestamp(cached.fetchedAtIso);
  const cacheAgeMs = cachedAt === null ? null : Math.max(0, Date.now() - cachedAt);
  return {
    ...cached,
    matches: markScheduleAsUnverified(cached.matches, { snapshot: cached.isSnapshot === true }),
    providerUsed: `${cached.providerUsed || "Données précédemment chargées"} • cache${cacheAgeMs === null ? " d'âge inconnu" : ` · ${Math.round(cacheAgeMs / 60000)} min`}`,
    isLiveNetwork: false,
    isSnapshot: cached.isSnapshot === true,
    isCached: true,
    isTrustedResults: false,
    cacheAgeMs,
  };
}

function saveDayCache(iso, payload) {
  MEMORY_DAY_CACHE.set(iso, payload);
  try {
    localStorage.setItem(SWR_CACHE_PREFIX + iso, JSON.stringify(payload));
  } catch {
    // ignore quota
  }
}

/**
 * Combine les rencontres Football-Data.org (FastAPI) avec le flux ESPN public multi-sport.
 * Les clés fournisseurs ne sont jamais lues ni envoyées depuis le navigateur.
 */
export async function fetchScheduleForOffset(offsetDays = 0, apiCfg = {}) {
  const { iso } = getOffsetDateStrings(offsetDays);
  const [footballDataPayload, espnPayload] = await Promise.all([
    fetchFootballDataForDay(iso),
    fetchOmniEspnForDay(offsetDays).catch(() => ({ matches: [], successfulEndpoints: 0 })),
  ]);
  const footballDataMatches = footballDataPayload?.matches || [];
  const espnMatches = espnPayload?.matches || [];
  const matches = mergeFootballSources(footballDataMatches, espnMatches);
  const hasFreshProviderResponse =
    footballDataPayload?.isLiveNetwork === true || (espnPayload?.successfulEndpoints || 0) > 0;
  const hasAnyProviderData =
    matches.length > 0 || hasFreshProviderResponse || footballDataPayload?.isSnapshot === true;

  if (hasAnyProviderData) {
    const providers = [];
    if (footballDataPayload?.available) providers.push("Football-Data.org v4");
    if ((espnPayload?.successfulEndpoints || 0) > 0) {
      providers.push(`ESPN multi-sport (${espnPayload.successfulEndpoints}/${OMNI_SPORT_ENDPOINTS.length} flux)`);
    }
    const cachedOnly = !hasFreshProviderResponse;
    const fetchedAtIso = hasFreshProviderResponse
      ? new Date().toISOString()
      : footballDataPayload?.fetchedAtIso || new Date().toISOString();
    const result = {
      matches,
      providerUsed: providers.length
        ? `${providers.join(" + ")} • ${matches.length} rencontre(s)`
        : `Cache Football-Data.org • ${matches.length} rencontre(s) — statut non revalidé`,
      fetchedAtIso,
      isLiveNetwork: hasFreshProviderResponse,
      isSnapshot: !hasFreshProviderResponse && footballDataPayload?.isSnapshot === true,
      isCached: cachedOnly,
      isTrustedResults: hasFreshProviderResponse,
    };
    saveDayCache(iso, result);
    return result;
  }

  // Un snapshot de déploiement sert uniquement d'archive d'affichage; il ne certifie
  // ni l'état Live, ni un score exploitable pour l'apprentissage.
  const snap = await loadCloudVerifiedSnapshot();
  if (isCloudSnapshotFresh(snap)) {
    const rawSnapshotMatches = getSnapshotMatchesForDate(snap, iso);
    if (rawSnapshotMatches.length > 0) {
      const ageMs = getCloudSnapshotAgeMs(snap);
      return {
        matches: markScheduleAsUnverified(rawSnapshotMatches, { snapshot: true }),
        providerUsed: `Snapshot historique • ${snap.generatedAtFr || snap.generatedAtIso || "date inconnue"} (${Math.round((ageMs || 0) / 60000)} min) — non revalidé`,
        fetchedAtIso: snap.generatedAtIso || snap.generatedAt || null,
        snapshotGeneratedAtIso: snap.generatedAtIso || snap.generatedAt || null,
        isLiveNetwork: false,
        isSnapshot: true,
        isCached: true,
        isTrustedResults: false,
      };
    }
  }

  // Cache local conservé pour lecture, avec tout statut Live invalidé.
  const cached = peekCachedScheduleForOffset(offsetDays);
  if (cached) {
    return {
      ...cached,
      providerUsed: `${cached.providerUsed} • flux officiel indisponible`,
      isLiveNetwork: false,
      isTrustedResults: false,
    };
  }

  const snapshotAgeMs = getCloudSnapshotAgeMs(snap);
  return {
    matches: [],
    providerUsed:
      snap && snapshotAgeMs !== null
        ? `Snapshot trop ancien (${Math.round(snapshotAgeMs / 3600000)} h) — ignoré; flux officiel indisponible`
        : "Aucun flux officiel récent détecté — abstention",
    fetchedAtIso: null,
    isLiveNetwork: false,
    isSnapshot: false,
    isCached: false,
    isTrustedResults: false,
  };
}

/**
 * DOSSIER DE VÉRITÉ TEMPS RÉEL (/summary?event={id}) :
 * Récupère en direct sur Internet :
 *  - Lieu exact (Stade, Ville, Pays, Capacité, Affluence, Arbitres)
 *  - TOUTES les confrontations directes (H2H) avec Date exacte, Compétition, Stade & Score exact
 *  - Les 5 derniers matchs de chaque équipe avec Dates exactes + calcul automatique des Jours de Repos
 *  - Forme des Joueurs Clés (Leaders officiels) + Blessés / Suspendus officiels !
 */
export async function fetchDeepMatchDossier(match) {
  if (!match) return null;
  const cacheKey = `${match.sportPath || "soccer"}:${match.rawEventId || match.externalId}`;
  const cachedDossier = DOSSIER_CACHE.get(cacheKey);
  if (cachedDossier && Date.now() - cachedDossier.cachedAtMs <= 5 * 60 * 1000) {
    return cachedDossier.dossier;
  }
  if (cachedDossier) DOSSIER_CACHE.delete(cacheKey);

  // Les dossiers de snapshot sont archivistiques; un snapshot trop vieux est ignoré.
  const snap = await loadCloudVerifiedSnapshot();
  const cloudDossier = isCloudSnapshotFresh(snap)
    ? snap?.dossiers?.[match.externalId] || null
    : null;

  if (match.sportPath === "soccer/football-data") {
    const dossier = {
      fetchedAtIso: match.fetchedAtIso || null,
      sourceUrl: "Football-Data.org",
      venueExact: {
        name: match.venue || "Non communiqué par le fournisseur",
        city: match.venueCity || "",
        country: match.venueCountry || "",
        capacity: null,
        attendance: null,
        officials: [],
      },
      h2hGames: [],
      homeRecent: [],
      awayRecent: [],
      restDaysHome: null,
      restDaysAway: null,
      injuries: [],
      playerLeaders: [...(match.leaders || [])],
      espnPredictor: null,
      pickcenter: null,
    };
    DOSSIER_CACHE.set(cacheKey, { dossier, cachedAtMs: Date.now() });
    return dossier;
  }

  if (!match.sportPath || !match.rawEventId || match.sportPath === "soccer/api-football") {
    return cloudDossier;
  }

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${match.sportPath}/summary?event=${match.rawEventId}`;
    const res = await fetchWithTimeout(url, {}, 7500);
    if (!res.ok) return cloudDossier;
    const json = await res.json();

    // 1. Stade, Ville, Pays, Affluence & Arbitres
    const gi = json.gameInfo || {};
    const vObj = gi.venue || {};
    const venueExact = {
      name: vObj.fullName || match.venue || "Non communiqué par l'organisateur",
      city: vObj.address?.city || match.venueCity || "",
      country: vObj.address?.country || vObj.address?.state || match.venueCountry || "",
      capacity: vObj.capacity || null,
      attendance: gi.attendance || match.attendance || null,
      grass: vObj.grass,
      indoor: vObj.indoor,
      officials: (gi.officials || []).map((o) => o.displayName).filter(Boolean),
    };

    // 2. Confrontations directes historiques (H2H) & Forme récente exacte des 2 équipes
    const h2hGames = [];
    const teamRecentGames = {};

    // Source A : json.headToHeadGames (Football, Basket, etc.)
    for (const block of json.headToHeadGames || []) {
      for (const ev of block.events || []) {
        const dt = ev.gameDate ? new Date(ev.gameDate) : null;
        const isBlockHome = ev.atVs !== "@";
        h2hGames.push({
          id: ev.id || `${ev.gameDate}-${ev.score}`,
          dateIso: ev.gameDate || "",
          dateExactFr: dt
            ? dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })
            : "Date officielle non fournie",
          homeTeam:
            ev.homeTeamName ||
            (isBlockHome ? block.team?.displayName : ev.opponent?.displayName) ||
            "",
          awayTeam:
            ev.awayTeamName ||
            (isBlockHome ? ev.opponent?.displayName : block.team?.displayName) ||
            "",
          score: ev.score || `${ev.homeTeamScore ?? "?"} - ${ev.awayTeamScore ?? "?"}`,
          competition: ev.leagueName || ev.leagueAbbreviation || match.leagueLabel || "",
          venue: ev.venue?.fullName || ev.location || (ev.atVs === "@" ? "Extérieur" : "Domicile"),
        });
      }
    }

    // Source B : json.boxscore.form (Forme détaillée des 5 derniers matchs de chaque club avec H2H croisés !)
    for (const fBlock of json.boxscore?.form || []) {
      const tName = fBlock.team?.displayName || "";
      const list = [];
      for (const ev of fBlock.events || []) {
        const dt = ev.gameDate ? new Date(ev.gameDate) : null;
        const item = {
          id: ev.id,
          dateIso: ev.gameDate || "",
          dateExactFr: dt
            ? dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })
            : "",
          opponent: ev.opponent?.displayName || "",
          score: ev.score || `${ev.homeTeamScore ?? ""}-${ev.awayTeamScore ?? ""}`,
          resultLetter: ev.gameResult || "", // W / D / L
          locationType: ev.atVs === "@" ? "Extérieur" : "Domicile",
          competition: ev.leagueName || "",
        };
        list.push(item);

        // Si cet adversaire est justement l'adversaire du duel actuel -> confrontation H2H vérifiée !
        if (
          normalizeKey(item.opponent) &&
          (normalizeKey(item.opponent) === normalizeKey(match.homeRaw) ||
            normalizeKey(item.opponent) === normalizeKey(match.awayRaw))
        ) {
          if (!h2hGames.some((x) => x.id === ev.id)) {
            h2hGames.push({
              id: ev.id,
              dateIso: item.dateIso,
              dateExactFr: item.dateExactFr,
              homeTeam: ev.homeTeamName || (ev.atVs === "@" ? item.opponent : tName),
              awayTeam: ev.awayTeamName || (ev.atVs === "@" ? tName : item.opponent),
              score: item.score,
              competition: item.competition,
              venue: item.locationType,
            });
          }
        }
      }
      if (tName) teamRecentGames[tName] = list;
    }

    // Source C : json.lastFiveGames (NBA / NFL / NHL / MLB)
    for (const lBlock of json.lastFiveGames || []) {
      const tName = lBlock.team?.displayName || "";
      if (tName && !teamRecentGames[tName]) {
        teamRecentGames[tName] = (lBlock.events || []).map((ev) => {
          const dt = ev.gameDate ? new Date(ev.gameDate) : null;
          return {
            id: ev.id,
            dateIso: ev.gameDate || "",
            dateExactFr: dt
              ? dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })
              : "",
            opponent: ev.opponent?.displayName || "",
            score: ev.score || "",
            resultLetter: ev.gameResult || "",
            locationType: ev.atVs === "@" ? "Extérieur" : "Domicile",
            competition: ev.leagueName || match.leagueLabel || "",
          };
        });
      }
    }

    // Dédoublonnage H2H + tri du plus récent au plus ancien
    const seenH2h = new Set();
    const dedupH2h = h2hGames
      .filter((g) => {
        const k = `${g.id || ""}-${g.dateExactFr}-${g.score}`;
        if (seenH2h.has(k)) return false;
        seenH2h.add(k);
        return true;
      })
      .sort((a, b) => String(b.dateIso).localeCompare(String(a.dateIso)));

    // 3. Calcul automatique de la fatigue réelle (jours de repos depuis le dernier match joué)
    const calcRestDays = (recentArr) => {
      if (!recentArr?.[0]?.dateIso || !match.kickoffIso) return null;
      const diffMs = new Date(match.kickoffIso).getTime() - new Date(recentArr[0].dateIso).getTime();
      const days = Math.round(diffMs / 86400000);
      return days >= 0 && days <= 30 ? days : null;
    };

    const keys = Object.keys(teamRecentGames);
    const homeRecent =
      teamRecentGames[match.homeRaw] ||
      teamRecentGames[keys.find((k) => normalizeKey(k) === normalizeKey(match.homeRaw))] ||
      [];
    const awayRecent =
      teamRecentGames[match.awayRaw] ||
      teamRecentGames[keys.find((k) => normalizeKey(k) === normalizeKey(match.awayRaw))] ||
      [];

    // 4. Blessés / Absences officiels (json.injuries)
    const injuries = [];
    for (const injTeam of json.injuries || []) {
      const teamLabel = injTeam.team?.displayName || "";
      for (const item of injTeam.injuries || []) {
        if (item.athlete?.displayName) {
          injuries.push({
            team: teamLabel,
            player: item.athlete.displayName,
            position: item.athlete.position?.abbreviation || "",
            status: item.status || "Absent",
            detail: item.details?.type || item.shortComment || "",
          });
        }
      }
    }

    // 5. Leaders / Forme des joueurs clés
    const playerLeaders = [...(match.leaders || [])];
    for (const lTeam of json.leaders || []) {
      const teamLabel = lTeam.team?.displayName || "";
      for (const cat of lTeam.leaders || []) {
        const top = cat.leaders?.[0];
        if (top?.athlete?.displayName) {
          playerLeaders.push({
            team: teamLabel,
            category: cat.displayName || cat.shortDisplayName || "Stat clé",
            player: top.athlete.displayName,
            value: top.displayValue || "",
          });
        }
      }
    }

    // 6. Cotes Marché officielles & Probabilité ESPN BPI
    const pick = json.pickcenter?.[0] || null;
    const espnPredictor = json.predictor
      ? {
          homeWinPct: Number(json.predictor.homeTeam?.gameProjection) || null,
          awayWinPct: Number(json.predictor.awayTeam?.gameProjection) || null,
        }
      : null;

    const dossier = {
      fetchedAtIso: new Date().toISOString(),
      sourceUrl: url,
      venueExact,
      h2hGames: dedupH2h.slice(0, 10),
      homeRecent: homeRecent.slice(0, 6),
      awayRecent: awayRecent.slice(0, 6),
      restDaysHome: calcRestDays(homeRecent),
      restDaysAway: calcRestDays(awayRecent),
      injuries: injuries.slice(0, 14),
      playerLeaders: playerLeaders.slice(0, 10),
      espnPredictor,
      pickcenter: pick
        ? {
            provider: pick.provider?.name || "Consensus",
            details: pick.details || "",
            overUnder: pick.overUnder ?? null,
          }
        : null,
    };

    DOSSIER_CACHE.set(cacheKey, { dossier, cachedAtMs: Date.now() });
    return dossier;
  } catch {
    return cloudDossier;
  }
}

export const OPTA_PRESET_PACK = [
  { team: "PSG", xgFor90: 2.38, xgAgainst90: 0.84, elo: 1978 },
  { team: "Liverpool", xgFor90: 2.32, xgAgainst90: 0.82, elo: 1995 },
  { team: "Arsenal", xgFor90: 2.15, xgAgainst90: 0.74, elo: 1988 },
  { team: "FC Barcelone", xgFor90: 2.49, xgAgainst90: 0.96, elo: 1986 },
  { team: "Real Madrid", xgFor90: 2.29, xgAgainst90: 0.88, elo: 1990 },
  { team: "Bayern Munich", xgFor90: 2.58, xgAgainst90: 0.89, elo: 1984 },
  { team: "Inter Milan", xgFor90: 2.18, xgAgainst90: 0.79, elo: 1968 },
  { team: "Manchester City", xgFor90: 2.26, xgAgainst90: 0.94, elo: 1970 },
  { team: "Bayer Leverkusen", xgFor90: 2.08, xgAgainst90: 0.95, elo: 1928 },
  { team: "Atalanta", xgFor90: 2.12, xgAgainst90: 0.99, elo: 1902 },
  { team: "Monaco", xgFor90: 1.96, xgAgainst90: 1.08, elo: 1805 },
  { team: "Marseille", xgFor90: 1.94, xgAgainst90: 1.11, elo: 1798 },
];

export function parseOptaDataFeed(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) throw new Error("Données Opta vides.");

  let rows = [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    rows = Array.isArray(parsed) ? parsed : parsed.teams || [];
  } else {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split(/[;,]/).map((s) => s.trim());
      if (parts.length < 3 || Number.isNaN(parseFloat(parts[1]))) continue;
      rows.push({
        team: parts[0],
        xgFor90: parseFloat(parts[1]),
        xgAgainst90: parseFloat(parts[2]),
        elo: parts[3] ? parseFloat(parts[3]) : undefined,
      });
    }
  }

  const overrides = {};
  let count = 0;
  for (const r of rows) {
    const canon = canonicalTeamName(r.team || r.name);
    const key = normalizeKey(canon);
    if (!key) continue;
    const xgf = Number(r.xgFor90 ?? r.xg);
    const xga = Number(r.xgAgainst90 ?? r.xga);
    if (Number.isNaN(xgf) || Number.isNaN(xga)) continue;

    overrides[key] = {
      name: canon,
      atk: Math.round(Math.min(1.9, Math.max(0.55, xgf / 1.55)) * 100) / 100,
      def: Math.round(Math.min(1.6, Math.max(0.52, xga / 1.25)) * 100) / 100,
      ...(r.elo && !Number.isNaN(Number(r.elo)) ? { elo: Number(r.elo) } : {}),
    };
    count += 1;
  }

  if (count === 0) {
    throw new Error("Aucune ligne valide détectée (attendu : Équipe, xG/90, xGA/90).");
  }
  return { overrides, count };
}
