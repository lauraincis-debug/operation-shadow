from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


LIVE_STATUSES = {"LIVE", "IN_PLAY", "PAUSED", "EXTRA_TIME", "PENALTY_SHOOTOUT"}
FINISHED_STATUSES = {"FINISHED", "AWARDED"}
PREMATCH_STATUSES = {"SCHEDULED", "TIMED", "NOT_STARTED"}

COMPETITION_LEAGUE_IDS = {
    "PL": "premier",
    "PD": "liga",
    "BL1": "bundesliga",
    "SA": "seriea",
    "FL1": "ligue1",
    "CL": "ucl",
    "EL": "europa",
    "ELC": "europa",
    "EC": "international",
    "WC": "international",
    "AFCON": "caf",
    "BSA": "world",
    "PPL": "world",
    "DED": "world",
    "CLI": "world",
    "ACL": "world",
}


def normalize_football_data_match(
    match: dict[str, Any],
    *,
    fetched_at: datetime,
    is_live_network: bool,
    is_stale: bool = False,
) -> dict[str, Any]:
    fixture_id = match.get("id")
    status = str(match.get("status") or "").upper()
    finished = status in FINISHED_STATUSES
    live = status in LIVE_STATUSES
    state = "post" if finished else "in" if live else "pre" if status in PREMATCH_STATUSES else "unknown"

    # Une entrée mise en cache ou servie après une erreur peut rester affichable,
    # mais elle ne doit jamais porter un badge Live ou autoriser l'analyse vidéo.
    if live and (not is_live_network or is_stale):
        state = "unknown"

    score = match.get("score") or {}
    full_time = score.get("fullTime") or {}
    home_goals = full_time.get("home")
    away_goals = full_time.get("away")
    if not finished:
        home_goals = None
        away_goals = None

    competition = match.get("competition") or {}
    home = match.get("homeTeam") or {}
    away = match.get("awayTeam") or {}
    fetched_at_iso = fetched_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    status_text = {
        "LIVE": "En cours",
        "IN_PLAY": "En cours",
        "PAUSED": "Pause",
        "FINISHED": "Terminé",
        "AWARDED": "Résultat officiel attribué",
        "SCHEDULED": "À venir",
        "TIMED": "À venir",
        "POSTPONED": "Reporté",
        "CANCELLED": "Annulé",
        "SUSPENDED": "Suspendu",
    }.get(status, "Statut fournisseur non reconnu")
    if live and (not is_live_network or is_stale):
        status_text = "Statut Live non revalidé — actualisation requise"
    elif finished and (home_goals is None or away_goals is None):
        status_text = "Terminé — score officiel indisponible"

    result: dict[str, Any] = {
        "externalId": f"football-data-{fixture_id}" if fixture_id is not None else "",
        "rawEventId": str(fixture_id or ""),
        "isRealInternet": True,
        "isLiveNetwork": bool(is_live_network and not is_stale),
        "isCached": not is_live_network or is_stale,
        "isSnapshot": bool(is_stale),
        "fetchedAtIso": fetched_at_iso,
        "source": "Football-Data.org",
        "sport": "soccer",
        "sportPath": "soccer/football-data",
        "leagueSlug": str(competition.get("code") or ""),
        "league": COMPETITION_LEAGUE_IDS.get(str(competition.get("code") or "").upper(), "world"),
        "leagueLabel": str(competition.get("name") or "Football"),
        "homeRaw": str(home.get("name") or home.get("shortName") or ""),
        "awayRaw": str(away.get("name") or away.get("shortName") or ""),
        "homeLogo": str(home.get("crest") or ""),
        "awayLogo": str(away.get("crest") or ""),
        "kickoffIso": str(match.get("utcDate") or ""),
        "venue": str(match.get("venue") or ""),
        "state": state,
        "completed": finished,
        "statusText": status_text,
        "scoreHome": home_goals,
        "scoreAway": away_goals,
        "competitionCode": str(competition.get("code") or ""),
        "officialStatus": status,
        "resultSource": "Football-Data.org" if finished and home_goals is not None and away_goals is not None else None,
    }
    if is_live_network and not is_stale:
        result["statusVerifiedAtIso"] = fetched_at_iso
        result["statusVerificationSource"] = "Football-Data.org"
    return result


def extract_football_data_matches(payload: dict[str, Any]) -> list[dict[str, Any]]:
    matches = payload.get("matches")
    return [item for item in matches if isinstance(item, dict)] if isinstance(matches, list) else []
