from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Tuple


DEFAULT_ALLOWED_ORIGINS = (
    "https://football-ai-43e33.web.app",
    "https://cloe-agent-abidjan.web.app",
    "https://cloe-ia-ultra.web.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


def _csv(value: str | None, fallback: Tuple[str, ...]) -> Tuple[str, ...]:
    if not value:
        return fallback
    return tuple(origin.strip().rstrip("/") for origin in value.split(",") if origin.strip())


@dataclass(frozen=True)
class Settings:
    football_data_api_key: str = ""
    api_football_key: str = ""
    database_url: str = ""
    football_data_base_url: str = "https://api.football-data.org/v4"
    api_football_base_url: str = "https://v3.football.api-sports.io"
    request_timeout_seconds: float = 8.0
    football_fixtures_ttl_seconds: int = 60
    football_results_ttl_seconds: int = 900
    football_standings_ttl_seconds: int = 21600
    player_stats_ttl_seconds: int = 3600
    stale_if_error_seconds: int = 86400
    rate_limit_per_minute: int = 240
    allowed_origins: Tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            football_data_api_key=os.getenv("FOOTBALL_DATA_API_KEY", "").strip(),
            api_football_key=os.getenv("API_FOOTBALL_KEY", "").strip(),
            database_url=os.getenv("DATABASE_URL", "").strip(),
            football_data_base_url=os.getenv(
                "FOOTBALL_DATA_BASE_URL", "https://api.football-data.org/v4"
            ).rstrip("/"),
            api_football_base_url=os.getenv(
                "API_FOOTBALL_BASE_URL", "https://v3.football.api-sports.io"
            ).rstrip("/"),
            request_timeout_seconds=float(os.getenv("UPSTREAM_TIMEOUT_SECONDS", "8")),
            football_fixtures_ttl_seconds=int(os.getenv("FOOTBALL_FIXTURES_TTL_SECONDS", "60")),
            football_results_ttl_seconds=int(os.getenv("FOOTBALL_RESULTS_TTL_SECONDS", "900")),
            football_standings_ttl_seconds=int(os.getenv("FOOTBALL_STANDINGS_TTL_SECONDS", "21600")),
            player_stats_ttl_seconds=int(os.getenv("PLAYER_STATS_TTL_SECONDS", "3600")),
            stale_if_error_seconds=int(os.getenv("STALE_IF_ERROR_SECONDS", "86400")),
            rate_limit_per_minute=int(os.getenv("RATE_LIMIT_PER_MINUTE", "240")),
            allowed_origins=_csv(os.getenv("CORS_ALLOW_ORIGINS"), DEFAULT_ALLOWED_ORIGINS),
        )
