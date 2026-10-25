from __future__ import annotations

from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from datetime import date, timedelta
import re
import time
import unicodedata
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .cache import MemoryJsonCache, PostgresJsonCache
from .normalization import extract_football_data_matches, normalize_football_data_match
from .providers import ProviderGateway, ProviderUnavailable, api_football_headers, football_data_headers
from .settings import Settings


def _provider_payload(result: Any, provider: str) -> dict[str, Any]:
    return {
        "provider": provider,
        "fetchedAtIso": result.fetched_at_iso,
        "isLiveNetwork": result.is_live_network,
        "isCached": result.is_cached,
        "isSnapshot": result.is_stale,
    }


def _football_matches_response(result: Any, *, requested_date: Optional[str] = None) -> dict[str, Any]:
    matches = [
        normalize_football_data_match(
            match,
            fetched_at=result.fetched_at,
            is_live_network=result.is_live_network,
            is_stale=result.is_stale,
        )
        for match in extract_football_data_matches(result.payload)
    ]
    response = {
        "available": True,
        **_provider_payload(result, "Football-Data.org"),
        "matches": matches,
    }
    if requested_date:
        response["date"] = requested_date
    return response


def create_app(
    settings: Optional[Settings] = None,
    cache_store: Any = None,
    http_client: Optional[httpx.AsyncClient] = None,
) -> FastAPI:
    configured_settings = settings or Settings.from_env()
    injected_cache = cache_store is not None
    injected_client = http_client is not None

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        cache = application.state.cache
        if not injected_cache and configured_settings.database_url:
            postgres_cache = PostgresJsonCache(configured_settings.database_url)
            try:
                await postgres_cache.initialize()
                cache = postgres_cache
                application.state.postgres_available = True
            except Exception:
                await postgres_cache.close()
                cache = MemoryJsonCache()
                application.state.postgres_available = False
        else:
            try:
                await cache.initialize()
            except Exception:
                cache = MemoryJsonCache()
                application.state.postgres_available = False

        client = application.state.http_client
        if client is None:
            client = httpx.AsyncClient(
                timeout=httpx.Timeout(configured_settings.request_timeout_seconds),
                follow_redirects=False,
            )
            application.state.http_client = client
            application.state.owns_http_client = True

        application.state.cache = cache
        application.state.cache_backend = cache.backend_name
        if configured_settings.database_url and cache.backend_name == "postgresql":
            application.state.postgres_available = True
        elif not configured_settings.database_url:
            application.state.postgres_available = False
        application.state.gateway = ProviderGateway(configured_settings, cache, client)
        try:
            yield
        finally:
            if application.state.owns_http_client:
                await application.state.http_client.aclose()
                application.state.http_client = None
            if cache.backend_name == "postgresql":
                await cache.close()

    application = FastAPI(
        title="Football AI — passerelle de données",
        version="1.0.0",
        description=(
            "Connecteurs Football-Data.org et API-Football côté serveur. "
            "Les clés ne sont jamais transmises au navigateur."
        ),
        lifespan=lifespan,
    )
    application.state.settings = configured_settings
    application.state.cache = cache_store or MemoryJsonCache()
    application.state.cache_backend = application.state.cache.backend_name
    application.state.postgres_available = False
    application.state.http_client = http_client
    application.state.owns_http_client = False
    application.state.gateway = (
        ProviderGateway(configured_settings, application.state.cache, http_client)
        if http_client is not None
        else None
    )

    # Limiteur glissant local au processus. Ce n'est pas un quota global si le service
    # démarre plusieurs workers/instances; voir backend/README.md avant toute exposition publique.
    request_times: OrderedDict[str, deque[float]] = OrderedDict()

    @application.middleware("http")
    async def rate_limit_api(request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or path == "/api/health":
            return await call_next(request)

        try:
            limit = max(1, int(request.app.state.settings.rate_limit_per_minute))
        except (TypeError, ValueError):
            limit = 240
        client_ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        window = request_times.get(client_ip)
        if window is None:
            window = deque()
            request_times[client_ip] = window
        else:
            request_times.move_to_end(client_ip)
        while window and now - window[0] >= 60:
            window.popleft()

        if len(window) >= limit:
            return JSONResponse(
                status_code=429,
                content={"detail": "Trop de requêtes : réessayez dans une minute."},
                headers={
                    "Retry-After": "60",
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            )

        window.append(now)
        # Borne la mémoire si de nombreuses adresses différentes sollicitent le processus.
        if len(request_times) > 10000:
            request_times.popitem(last=False)
        return await call_next(request)

    @application.middleware("http")
    async def prevent_shared_api_caching(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    # CORS doit rester extérieur aux middlewares maison afin que les 429 gardent leurs en-têtes CORS.
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(configured_settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "OPTIONS"],
        allow_headers=["Accept", "Content-Type"],
    )

    def gateway_for(request: Request) -> ProviderGateway:
        gateway = request.app.state.gateway
        if gateway is None:
            raise HTTPException(status_code=503, detail="La passerelle de données n'est pas initialisée")
        return gateway

    @application.get("/api/health", tags=["État"])
    async def health(request: Request) -> dict[str, Any]:
        current_settings: Settings = request.app.state.settings
        return {
            "status": "ok",
            "service": "football-ai-data-api",
            "cache": {
                "backend": request.app.state.cache_backend,
                "postgresAvailable": bool(request.app.state.postgres_available),
            },
            "providers": {
                "footballDataConfigured": bool(current_settings.football_data_api_key),
                "apiFootballConfigured": bool(current_settings.api_football_key),
            },
            "keysExposedToClient": False,
        }

    @application.get("/api/football/fixtures", tags=["Football-Data.org"])
    async def football_fixtures(
        request: Request,
        match_date: date = Query(..., alias="date"),
    ) -> dict[str, Any]:
        current_settings: Settings = request.app.state.settings
        if not current_settings.football_data_api_key:
            raise HTTPException(
                status_code=503,
                detail="Le connecteur Football-Data.org n'est pas configuré côté serveur",
            )
        gateway = gateway_for(request)
        try:
            result = await gateway.request_json(
                provider="football-data.org",
                url=f"{current_settings.football_data_base_url}/matches",
                params={"dateFrom": match_date.isoformat(), "dateTo": match_date.isoformat()},
                headers=football_data_headers(current_settings),
                credential=current_settings.football_data_api_key,
                ttl_seconds=current_settings.football_fixtures_ttl_seconds,
            )
        except ProviderUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return _football_matches_response(result, requested_date=match_date.isoformat())

    @application.get("/api/football/results", tags=["Football-Data.org"])
    async def football_results(
        request: Request,
        date_from: date = Query(default_factory=lambda: date.today() - timedelta(days=7), alias="dateFrom"),
        date_to: date = Query(default_factory=date.today, alias="dateTo"),
    ) -> dict[str, Any]:
        if date_to < date_from or (date_to - date_from).days > 31:
            raise HTTPException(status_code=400, detail="La période doit couvrir de 0 à 31 jours")
        current_settings: Settings = request.app.state.settings
        if not current_settings.football_data_api_key:
            raise HTTPException(
                status_code=503,
                detail="Le connecteur Football-Data.org n'est pas configuré côté serveur",
            )
        gateway = gateway_for(request)
        try:
            result = await gateway.request_json(
                provider="football-data.org",
                url=f"{current_settings.football_data_base_url}/matches",
                params={"dateFrom": date_from.isoformat(), "dateTo": date_to.isoformat()},
                headers=football_data_headers(current_settings),
                credential=current_settings.football_data_api_key,
                ttl_seconds=current_settings.football_results_ttl_seconds,
            )
        except ProviderUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        response = _football_matches_response(result)
        response["dateFrom"] = date_from.isoformat()
        response["dateTo"] = date_to.isoformat()
        response["matches"] = [match for match in response["matches"] if match["completed"]]
        return response

    @application.get("/api/football/standings/{competition_code}", tags=["Football-Data.org"])
    async def football_standings(
        competition_code: str,
        request: Request,
        season: Optional[int] = Query(default=None, ge=1900, le=2200),
    ) -> dict[str, Any]:
        if not competition_code.isalnum() or not 2 <= len(competition_code) <= 10:
            raise HTTPException(status_code=400, detail="Code de compétition invalide")
        current_settings: Settings = request.app.state.settings
        if not current_settings.football_data_api_key:
            raise HTTPException(
                status_code=503,
                detail="Le connecteur Football-Data.org n'est pas configuré côté serveur",
            )
        params = {"season": season} if season is not None else None
        gateway = gateway_for(request)
        try:
            result = await gateway.request_json(
                provider="football-data.org",
                url=f"{current_settings.football_data_base_url}/competitions/{competition_code.upper()}/standings",
                params=params,
                headers=football_data_headers(current_settings),
                credential=current_settings.football_data_api_key,
                ttl_seconds=current_settings.football_standings_ttl_seconds,
            )
        except ProviderUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {
            "available": True,
            **_provider_payload(result, "Football-Data.org"),
            "competition": result.payload.get("competition"),
            "season": result.payload.get("season"),
            "standings": result.payload.get("standings", []),
        }

    @application.get("/api/football/matches/{match_id}", tags=["Football-Data.org"])
    async def football_match_status(
        match_id: int,
        request: Request,
        revalidate: bool = Query(default=True),
    ) -> dict[str, Any]:
        if match_id <= 0:
            raise HTTPException(status_code=400, detail="Identifiant de rencontre invalide")
        current_settings: Settings = request.app.state.settings
        if not current_settings.football_data_api_key:
            raise HTTPException(
                status_code=503,
                detail="Le connecteur Football-Data.org n'est pas configuré côté serveur",
            )
        gateway = gateway_for(request)
        try:
            result = await gateway.request_json(
                provider="football-data.org",
                url=f"{current_settings.football_data_base_url}/matches/{match_id}",
                headers=football_data_headers(current_settings),
                credential=current_settings.football_data_api_key,
                ttl_seconds=5,
                force_refresh=revalidate,
            )
        except ProviderUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        match = result.payload.get("match")
        if not isinstance(match, dict) and isinstance(result.payload.get("id"), int):
            match = result.payload
        if not isinstance(match, dict):
            raise HTTPException(status_code=502, detail="Réponse de match invalide du fournisseur")
        normalized = normalize_football_data_match(
            match,
            fetched_at=result.fetched_at,
            is_live_network=result.is_live_network,
            is_stale=result.is_stale,
        )
        return {
            "available": True,
            **_provider_payload(result, "Football-Data.org"),
            "match": normalized,
        }

    @application.get("/api/football/player-stats", tags=["API-Football"])
    async def api_football_player_stats(
        request: Request,
        team_id: Optional[int] = Query(default=None, gt=0),
        team_name: Optional[str] = Query(default=None, min_length=2, max_length=80),
        season: int = Query(..., ge=1990, le=2200),
        league_id: Optional[int] = Query(default=None, gt=0),
    ) -> dict[str, Any]:
        current_settings: Settings = request.app.state.settings
        if not current_settings.api_football_key:
            raise HTTPException(
                status_code=503,
                detail="Le connecteur API-Football n'est pas configuré côté serveur",
            )
        if (team_id is None) == (team_name is None):
            raise HTTPException(
                status_code=400,
                detail="Fournir un seul identifiant team_id ou un team_name à résoudre exactement",
            )
        gateway = gateway_for(request)
        resolved_team: Optional[dict[str, Any]] = {"id": team_id} if team_id is not None else None
        try:
            if team_name is not None:
                search = await gateway.request_json(
                    provider="api-football",
                    url=f"{current_settings.api_football_base_url}/teams",
                    params={"search": team_name.strip()},
                    headers=api_football_headers(current_settings),
                    credential=current_settings.api_football_key,
                    ttl_seconds=86400,
                )
                candidates = search.payload.get("response", [])
                normalize_name = lambda value: re.sub(
                    r"[^a-z0-9]+",
                    " ",
                    "".join(
                        char
                        for char in unicodedata.normalize("NFKD", str(value or "").casefold())
                        if not unicodedata.combining(char)
                    ),
                ).strip()
                target = normalize_name(team_name)

                def comparable_name(value: Any) -> str:
                    words = normalize_name(value).split()
                    while words and words[-1] in {"fc", "cf", "sc", "afc", "club"}:
                        words.pop()
                    while words and words[0] in {"fc", "cf", "sc", "ac"}:
                        words.pop(0)
                    return " ".join(words)

                exact = [
                    item
                    for item in candidates
                    if comparable_name((item.get("team") or {}).get("name")) == comparable_name(target)
                ]
                if len(exact) != 1:
                    return {
                        "available": True,
                        "matched": False,
                        "reason": "Aucune correspondance exacte" if not exact else "Correspondance ambiguë",
                        "provider": "API-Football",
                        "fetchedAtIso": search.fetched_at_iso,
                        "isLiveNetwork": search.is_live_network,
                        "isCached": search.is_cached,
                        "isSnapshot": search.is_stale,
                        "players": [],
                    }
                resolved_team = (exact[0].get("team") or {}).copy()
                team_id = int(resolved_team.get("id") or 0)
                if team_id <= 0:
                    raise HTTPException(status_code=502, detail="Identifiant équipe fournisseur invalide")

            params: dict[str, Any] = {"team": team_id, "season": season}
            if league_id is not None:
                params["league"] = league_id
            result = await gateway.request_json(
                provider="api-football",
                url=f"{current_settings.api_football_base_url}/players",
                params=params,
                headers=api_football_headers(current_settings),
                credential=current_settings.api_football_key,
                ttl_seconds=current_settings.player_stats_ttl_seconds,
            )
        except ProviderUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {
            "available": True,
            "matched": True,
            **_provider_payload(result, "API-Football"),
            "resolvedTeam": resolved_team,
            "players": result.payload.get("response", []),
            "paging": result.payload.get("paging", {}),
        }

    return application


app = create_app()
