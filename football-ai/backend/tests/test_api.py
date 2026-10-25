from __future__ import annotations

import asyncio

import httpx

from app.cache import MemoryJsonCache
from app.main import create_app
from app.settings import Settings


TOKEN_FD = "football-data-server-secret-test"
TOKEN_AF = "api-football-server-secret-test"


def upstream_match(match_id: int = 10, status: str = "IN_PLAY") -> dict:
    return {
        "id": match_id,
        "utcDate": "2026-10-25T16:00:00Z",
        "status": status,
        "competition": {"id": 2021, "name": "Premier League", "code": "PL"},
        "homeTeam": {"id": 1, "name": "Arsenal FC", "crest": "https://example.test/arsenal.png"},
        "awayTeam": {"id": 2, "name": "Chelsea FC", "crest": "https://example.test/chelsea.png"},
        "score": {
            "fullTime": {
                "home": 2 if status == "FINISHED" else None,
                "away": 1 if status == "FINISHED" else None,
            }
        },
        "venue": "Emirates Stadium",
    }


def make_app(handler, *, settings: Settings | None = None):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    configured = settings or Settings(
        football_data_api_key=TOKEN_FD,
        api_football_key=TOKEN_AF,
        football_data_base_url="https://fd.test/v4",
        api_football_base_url="https://af.test",
    )
    app = create_app(configured, cache_store=MemoryJsonCache(), http_client=client)
    return app, client


async def get(app, path: str):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get(path)


def test_health_does_not_expose_keys():
    async def run():
        app, upstream = make_app(lambda request: httpx.Response(200, json={}))
        try:
            response = await get(app, "/api/health")
            assert response.status_code == 200
            body = response.json()
            assert body["providers"] == {
                "footballDataConfigured": True,
                "apiFootballConfigured": True,
            }
            assert body["keysExposedToClient"] is False
            assert TOKEN_FD not in response.text
            assert TOKEN_AF not in response.text
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_football_data_fixtures_normalize_status_and_keep_key_server_side():
    async def run():
        seen_headers: list[dict[str, str]] = []

        def handler(request: httpx.Request):
            seen_headers.append(dict(request.headers))
            return httpx.Response(
                200,
                json={"matches": [upstream_match(), upstream_match(11, "SCHEDULED")]},
            )

        app, upstream = make_app(handler)
        try:
            response = await get(app, "/api/football/fixtures?date=2026-10-25")
            assert response.status_code == 200
            body = response.json()
            assert body["provider"] == "Football-Data.org"
            assert body["isLiveNetwork"] is True
            assert len(body["matches"]) == 2
            live = body["matches"][0]
            assert live["externalId"] == "football-data-10"
            assert live["state"] == "in"
            assert live["statusVerificationSource"] == "Football-Data.org"
            assert live["league"] == "premier"
            assert seen_headers[0]["x-auth-token"] == TOKEN_FD
            assert TOKEN_FD not in response.text
            assert response.headers["cache-control"] == "no-store"
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_cache_hit_never_revalidates_or_displays_cached_live_status():
    async def run():
        calls = 0

        def handler(request: httpx.Request):
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"matches": [upstream_match()]})

        app, upstream = make_app(handler)
        try:
            first = await get(app, "/api/football/fixtures?date=2026-10-25")
            second = await get(app, "/api/football/fixtures?date=2026-10-25")
            assert first.status_code == second.status_code == 200
            assert calls == 1
            assert first.json()["matches"][0]["state"] == "in"
            cached_body = second.json()
            assert cached_body["isCached"] is True
            assert cached_body["isLiveNetwork"] is False
            assert cached_body["matches"][0]["state"] == "unknown"
            assert cached_body["matches"][0]["statusText"].startswith("Statut Live non revalidé")
            assert "statusVerifiedAtIso" not in cached_body["matches"][0]
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_expired_cache_after_provider_error_is_explicitly_stale_and_not_live():
    async def run():
        calls = 0

        def handler(request: httpx.Request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(200, json={"matches": [upstream_match()]})
            raise httpx.ConnectError("upstream unavailable", request=request)

        settings = Settings(
            football_data_api_key=TOKEN_FD,
            football_data_base_url="https://fd.test/v4",
            football_fixtures_ttl_seconds=0,
            stale_if_error_seconds=3600,
        )
        app, upstream = make_app(handler, settings=settings)
        try:
            first = await get(app, "/api/football/fixtures?date=2026-10-25")
            second = await get(app, "/api/football/fixtures?date=2026-10-25")
            assert first.status_code == second.status_code == 200
            stale = second.json()
            assert stale["isSnapshot"] is True
            assert stale["isLiveNetwork"] is False
            assert stale["matches"][0]["state"] == "unknown"
            assert stale["matches"][0]["isLiveNetwork"] is False
            assert "statusVerifiedAtIso" not in stale["matches"][0]
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_results_return_only_final_official_scores():
    async def run():
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request):
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "matches": [
                        upstream_match(10, "FINISHED"),
                        upstream_match(11, "IN_PLAY"),
                    ]
                },
            )

        app, upstream = make_app(handler)
        try:
            response = await get(
                app,
                "/api/football/results?dateFrom=2026-10-24&dateTo=2026-10-25",
            )
            assert response.status_code == 200
            body = response.json()
            assert len(body["matches"]) == 1
            assert body["matches"][0]["completed"] is True
            assert body["matches"][0]["scoreHome"] == 2
            assert body["matches"][0]["scoreAway"] == 1
            assert requests[0].url.params["dateFrom"] == "2026-10-24"
            assert requests[0].url.params["dateTo"] == "2026-10-25"
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_standings_route_proxies_competition_code_and_optional_season():
    async def run():
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request):
            seen.append(request)
            return httpx.Response(
                200,
                json={
                    "competition": {"code": "PL", "name": "Premier League"},
                    "season": {"startDate": "2026-08-01"},
                    "standings": [{"type": "TOTAL", "table": [{"position": 1, "team": {"name": "Arsenal FC"}}]}],
                },
            )

        app, upstream = make_app(handler)
        try:
            response = await get(app, "/api/football/standings/PL?season=2026")
            assert response.status_code == 200
            assert response.json()["standings"][0]["table"][0]["position"] == 1
            assert seen[0].url.path.endswith("/competitions/PL/standings")
            assert seen[0].url.params["season"] == "2026"
            bad = await get(app, "/api/football/standings/PL%2F..%2Fmatches")
            assert bad.status_code in (400, 404, 422)
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_video_revalidation_bypasses_cache_and_stale_fallback_is_not_live():
    async def run():
        calls = 0

        def handler(request: httpx.Request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(200, json=upstream_match())
            raise httpx.ConnectError("upstream unavailable", request=request)

        app, upstream = make_app(handler)
        try:
            initial = await get(app, "/api/football/matches/10?revalidate=false")
            assert initial.status_code == 200
            assert initial.json()["isLiveNetwork"] is True
            revalidated = await get(app, "/api/football/matches/10?revalidate=true")
            assert revalidated.status_code == 200
            assert calls == 2
            assert revalidated.json()["isLiveNetwork"] is False
            assert revalidated.json()["isSnapshot"] is True
            assert revalidated.json()["match"]["state"] == "unknown"
            assert "statusVerifiedAtIso" not in revalidated.json()["match"]
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_api_football_player_stats_uses_server_key_and_redacts_it_from_response():
    async def run():
        seen_requests: list[httpx.Request] = []

        def handler(request: httpx.Request):
            seen_requests.append(request)
            return httpx.Response(
                200,
                json={"response": [{"player": {"id": 77, "name": "Joueur exemple"}, "statistics": []}]},
            )

        app, upstream = make_app(handler)
        try:
            response = await get(
                app,
                "/api/football/player-stats?team_id=42&season=2026&league_id=39",
            )
            assert response.status_code == 200
            assert response.json()["players"][0]["player"]["id"] == 77
            assert seen_requests[0].headers["x-apisports-key"] == TOKEN_AF
            assert seen_requests[0].url.params["league"] == "39"
            assert seen_requests[0].url.params["team"] == "42"
            assert TOKEN_AF not in response.text
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_api_football_resolves_team_name_only_on_an_exact_server_side_match():
    async def run():
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request):
            seen.append(request)
            if request.url.path.endswith("/teams"):
                return httpx.Response(
                    200,
                    json={"response": [{"team": {"id": 42, "name": "Arsenal"}}]},
                )
            return httpx.Response(
                200,
                json={"response": [{"player": {"id": 77, "name": "Joueur exemple"}, "statistics": []}]},
            )

        app, upstream = make_app(handler)
        try:
            response = await get(
                app,
                "/api/football/player-stats?team_name=Arsenal%20FC&season=2026&league_id=39",
            )
            assert response.status_code == 200
            body = response.json()
            assert body["matched"] is True
            assert body["resolvedTeam"]["id"] == 42
            assert len(seen) == 2
            assert seen[0].url.params["search"] == "Arsenal FC"
            assert seen[1].url.params["team"] == "42"
            assert all(req.headers["x-apisports-key"] == TOKEN_AF for req in seen)
            assert TOKEN_AF not in response.text
        finally:
            await upstream.aclose()

    asyncio.run(run())


def test_missing_provider_key_is_reported_without_leaking_configuration():

    async def run():
        settings = Settings(football_data_api_key="", api_football_key="")
        app, upstream = make_app(lambda request: httpx.Response(200, json={}), settings=settings)
        try:
            response = await get(app, "/api/football/fixtures?date=2026-10-25")
            assert response.status_code == 503
            assert "pas configuré côté serveur" in response.json()["detail"]
            assert TOKEN_FD not in response.text
        finally:
            await upstream.aclose()

    asyncio.run(run())
