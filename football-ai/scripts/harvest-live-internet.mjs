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
import { verifyOfficialVideoCandidate } from "../src/engine/videoAnalyzer.js";

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

async function harvestTopDossierAndVideos(m, verifiedVideosOut) {
  if (!m.sportPath || !m.rawEventId) return null;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${m.sportPath}/summary?event=${m.rawEventId}`;
  const json = await fetchJsonSafe(url, 6000);
  if (!json) return null;

  // Extraire et VÉRIFIER STRICTEMENT (bon match + date exacte ±36h) toutes les vidéos officielles ESPN !
  const vids = Array.isArray(json.videos) ? json.videos : [];
  for (let i = 0; i < vids.length; i++) {
    const v = vids[i];
    const mp4Url =
      v?.links?.source?.HD?.href ||
      v?.links?.source?.full?.href ||
      v?.links?.source?.href ||
      v?.links?.mobile?.source?.href ||
      "";
    const candidate = {
      id: `espn-${m.rawEventId}-${v.id || i}`,
      provider: "ESPN Official Stream",
      sameOfficialEventId: true,
      homeTeam: m.home,
      awayTeam: m.away,
      competition: m.leagueLabel || "",
      title: v.headline || v.title || `${m.home} vs ${m.away}`,
      description: v.description || "",
      dateIso: v.originalPublishDate || v.lastModified || m.kickoffIso,
      durationSec: v.duration || null,
      thumbnail: v.thumbnail || "",
      mp4Url: mp4Url.startsWith("http://") ? mp4Url.replace("http://", "https://") : mp4Url,
      embedSrc: "",
    };
    const check = verifyOfficialVideoCandidate(candidate, m);
    if (check.verified) {
      verifiedVideosOut.push({ ...candidate, verification: check });
    }
  }

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
const verifiedVideos = [];

// Prioriser les sports collectifs filmés en direct ("in") et tout juste terminés ("post") : Football, NBA, NHL, NFL, MLB !
const teamSportsFirst = allMatches.filter((m) => m.sport !== "tennis");
const liveAndRecentFirst = [
  ...teamSportsFirst.filter((m) => m.state === "in"),
  ...teamSportsFirst.filter((m) => m.state === "post"),
  ...teamSportsFirst.filter((m) => m.state !== "in" && m.state !== "post"),
].slice(0, 40);

await Promise.all(
  liveAndRecentFirst.map(async (m) => {
    const d = await harvestTopDossierAndVideos(m, verifiedVideos);
    if (d) dossiers[m.externalId] = d;
  })
);

// Récolter également le flux vidéo mondial ScoreBat v3 et certifier chaque clip (bon match + date exacte ±36h)
let scorebatRejectedWrongMatchOrDate = 0;
const sbJson = await fetchJsonSafe("https://www.scorebat.com/video-api/v3/", 6000);
if (Array.isArray(sbJson?.response)) {
  for (let idx = 0; idx < sbJson.response.length; idx++) {
    const item = sbJson.response[idx];
    const side1 = item?.side1?.name || (item?.title || "").split(" - ")[0] || "";
    const side2 = item?.side2?.name || (item?.title || "").split(" - ")[1] || "";
    const srcMatch = String(item?.embed || "").match(/src=['"](https:\/\/[^'"]+)['"]/i);
    const embedSrc = srcMatch ? srcMatch[1] : "";
    const cand = {
      id: `scorebat-${idx}`,
      provider: "ScoreBat Live Video Feed",
      sameOfficialEventId: false,
      homeTeam: side1.trim(),
      awayTeam: side2.trim(),
      competition: item?.competition || "",
      title: `${side1.trim()} vs ${side2.trim()} — ${item?.videos?.[0]?.title || "Temps forts officiels"}`,
      description: `Compétition officielle : ${item?.competition || "Football"}`,
      dateIso: item?.date || "",
      durationSec: 120,
      thumbnail: item?.thumbnail || "",
      mp4Url: "",
      embedSrc,
    };
    const matchingOfficialGame = allMatches.find((m) => verifyOfficialVideoCandidate(cand, m).verified);
    if (matchingOfficialGame) {
      verifiedVideos.push({
        ...cand,
        verification: verifyOfficialVideoCandidate(cand, matchingOfficialGame),
      });
    } else {
      scorebatRejectedWrongMatchOrDate++;
    }
  }
}

const bySport = {};
for (const m of allMatches) {
  bySport[m.sport] = (bySport[m.sport] || 0) + 1;
}

const now = new Date();
const payload = {
  version: "6.1.0-certified",
  generatedAtIso: now.toISOString(),
  generatedAtFr: now.toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC",
  totalMatchesHarvested: allMatches.length,
  countsBySport: bySport,
  dossiersCount: Object.keys(dossiers).length,
  verifiedVideosCount: verifiedVideos.length,
  sha256Integrity: "",
  days,
  dossiers,
  verifiedVideos: verifiedVideos.slice(0, 60),
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

const sampleVideos = verifiedVideos.slice(0, 10).map((v) => ({
  provider: v.provider,
  title: v.title,
  verifiedTeams: `${v.homeTeam} vs ${v.awayTeam}`,
  publishedAt: v.dateIso,
  verifiedDateFr: v.verification?.videoDateFr,
  deltaHoursFromKickoff: v.verification?.deltaHours,
  hasDirectMp4: Boolean(v.mp4Url),
}));

writeFileSync(
  OUT_REPORT,
  JSON.stringify(
    {
      status: allMatches.length > 0 ? "LIVE_INTERNET_HARVEST_V6_1_CERTIFIED_OK" : "OFFLINE_SANDBOX_BUILD",
      version: "6.1.0-certified",
      harvestedAt: payload.generatedAtIso,
      sha256Integrity: payload.sha256Integrity,
      totalMatchesAcross4Days: allMatches.length,
      countsBySport: bySport,
      deepDossiersPreloaded: Object.keys(dossiers).length,
      verifiedOfficialVideosCount: verifiedVideos.length,
      unmatchedOrWrongDateVideosBlocked: scorebatRejectedWrongMatchOrDate,
      sampleCertifiedOfficialVideos: sampleVideos,
      sampleVerifiedRealMatches: sampleMatches,
    },
    null,
    2
  ),
  "utf8"
);

console.log(
  `✓ Harvest Internet Omni-Sport v6.1 Certifiée terminé : ${allMatches.length} vrais matchs + ${verifiedVideos.length} vidéos officielles certifiées (bon match + date exacte)`
);
