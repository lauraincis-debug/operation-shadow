import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  OMNI_SPORT_ENDPOINTS,
  getOffsetDateStrings,
  parseOmniEspnEvent,
} from "../src/services/liveMatchesApi.js";
import { normalizeKey } from "../src/data/clubs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_WWW = resolve(__dirname, "../www/live-omni-snapshot.json");
const OUT_CLOE_ABIDJAN = resolve(__dirname, "../../cloe-abidjan/live-omni-snapshot.json");
const OUT_REPORT = resolve(__dirname, "../../cloe-abidjan/LIVE_INTERNET_HARVEST_REPORT.json");

async function fetchJsonSafe(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function harvestDay(offset) {
  const { compact } = getOffsetDateStrings(offset);
  const settled = await Promise.all(
    OMNI_SPORT_ENDPOINTS.map(async (ep) => {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${ep.sportPath}/scoreboard?dates=${compact}`;
      const json = await fetchJsonSafe(url, 6000);
      if (!json?.events) return [];
      return json.events.flatMap((ev) => parseOmniEspnEvent(ev, ep));
    })
  );
  const flat = settled.flat();
  const seen = new Set();
  return flat.filter((m) => {
    const k = `${m.sport}__${normalizeKey(m.home)}__${normalizeKey(m.away)}__${m.dateFr}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function harvestTopDossier(m) {
  if (!m.sportPath || !m.rawEventId) return null;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${m.sportPath}/summary?event=${m.rawEventId}`;
  const json = await fetchJsonSafe(url, 6000);
  if (!json) return null;

  const gi = json.gameInfo || {};
  const vObj = gi.venue || {};
  const h2hGames = [];
  for (const block of json.headToHeadGames || []) {
    for (const ev of block.events || []) {
      const dt = ev.gameDate ? new Date(ev.gameDate) : null;
      h2hGames.push({
        id: ev.id || `${ev.gameDate}-${ev.score}`,
        dateIso: ev.gameDate || "",
        dateExactFr: dt
          ? dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })
          : "",
        homeTeam: ev.homeTeamName || block.team?.displayName || "",
        awayTeam: ev.awayTeamName || ev.opponent?.displayName || "",
        score: ev.score || `${ev.homeTeamScore ?? "?"}-${ev.awayTeamScore ?? "?"}`,
        competition: ev.leagueName || m.leagueLabel || "",
        venue: ev.venue?.fullName || ev.location || "",
      });
    }
  }

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
          detail: item.details?.type || "",
        });
      }
    }
  }

  return {
    fetchedAtIso: new Date().toISOString(),
    sourceUrl: url,
    venueExact: {
      name: vObj.fullName || m.venue || "Non publié",
      city: vObj.address?.city || m.venueCity || "",
      country: vObj.address?.country || m.venueCountry || "",
      capacity: vObj.capacity || null,
      attendance: gi.attendance || null,
      officials: (gi.officials || []).map((o) => o.displayName).filter(Boolean),
    },
    h2hGames: h2hGames.slice(0, 8),
    injuries: injuries.slice(0, 10),
  };
}

const days = {};
for (const off of [-1, 0, 1, 2]) {
  days[String(off)] = await harvestDay(off);
}

const allMatches = Object.values(days).flat();
const dossiers = {};

// Pré-charger les dossiers H2H/Stade/Blessés des 18 affiches principales multi-sports
const priorityMatches = allMatches.slice(0, 18);
await Promise.all(
  priorityMatches.map(async (m) => {
    const d = await harvestTopDossier(m);
    if (d) dossiers[m.externalId] = d;
  })
);

const bySport = {};
for (const m of allMatches) {
  bySport[m.sport] = (bySport[m.sport] || 0) + 1;
}

const now = new Date();
const payload = {
  version: "6.0.0-omni-truth",
  generatedAtIso: now.toISOString(),
  generatedAtFr: now.toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC",
  totalMatchesHarvested: allMatches.length,
  countsBySport: bySport,
  dossiersCount: Object.keys(dossiers).length,
  sha256Integrity: "",
  days,
  dossiers,
};

payload.sha256Integrity = createHash("sha256")
  .update(JSON.stringify(payload.days))
  .digest("hex")
  .slice(0, 24);

mkdirSync(dirname(OUT_WWW), { recursive: true });
mkdirSync(dirname(OUT_CLOE_ABIDJAN), { recursive: true });
writeFileSync(OUT_WWW, JSON.stringify(payload), "utf8");
writeFileSync(OUT_CLOE_ABIDJAN, JSON.stringify(payload), "utf8");

const sampleMatches = allMatches.slice(0, 12).map((m) => ({
  sport: m.sport,
  competition: m.leagueLabel,
  match: `${m.home} vs ${m.away}`,
  dateExact: m.fullDateFr || m.dateFr,
  time: m.timeStr,
  venueExact: m.venueFull || m.venue || "Non publié",
  status: m.statusText,
  score: m.scoreHome !== null ? `${m.scoreHome}-${m.scoreAway}` : null,
}));

writeFileSync(
  OUT_REPORT,
  JSON.stringify(
    {
      status: allMatches.length > 0 ? "LIVE_INTERNET_HARVEST_OK" : "OFFLINE_SANDBOX_BUILD",
      harvestedAt: payload.generatedAtIso,
      sha256Integrity: payload.sha256Integrity,
      totalMatchesAcross4Days: allMatches.length,
      countsBySport: bySport,
      deepDossiersPreloaded: Object.keys(dossiers).length,
      sampleVerifiedRealMatches: sampleMatches,
    },
    null,
    2
  ),
  "utf8"
);

console.log(
  `✓ Harvest Internet Omni-Sport v6 terminé : ${allMatches.length} vrais matchs récoltés (${JSON.stringify(bySport)})`
);
