from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional


@dataclass(frozen=True)
class CacheEntry:
    payload: Any
    fetched_at: datetime
    expires_at: datetime

    @property
    def is_stale(self) -> bool:
        return self.expires_at <= datetime.now(timezone.utc)

    @property
    def age_seconds(self) -> int:
        return max(0, int((datetime.now(timezone.utc) - self.fetched_at).total_seconds()))


class MemoryJsonCache:
    """Cache de repli, uniquement pour le développement et les pannes PostgreSQL."""

    backend_name = "memory"

    def __init__(self) -> None:
        self._entries: dict[str, CacheEntry] = {}

    async def initialize(self) -> None:
        return None

    async def get(self, key: str, allow_expired: bool = False) -> Optional[CacheEntry]:
        entry = self._entries.get(key)
        if not entry:
            return None
        if entry.is_stale and not allow_expired:
            return None
        return entry

    async def set(
        self, key: str, payload: Any, ttl_seconds: int, provider: str = "memory"
    ) -> CacheEntry:
        now = datetime.now(timezone.utc)
        entry = CacheEntry(
            payload=payload,
            fetched_at=now,
            expires_at=now + timedelta(seconds=max(0, ttl_seconds)),
        )
        self._entries[key] = entry
        return entry

    async def close(self) -> None:
        self._entries.clear()


class PostgresJsonCache:
    """Cache JSONB PostgreSQL partagé entre instances FastAPI."""

    backend_name = "postgresql"

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.pool = None

    @staticmethod
    def _asyncpg_dsn(database_url: str) -> str:
        # Accepte les URL postgresql:// et les URL de plateformes SQLAlchemy.
        return (
            database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
            .replace("postgres+asyncpg://", "postgresql://", 1)
        )

    async def initialize(self) -> None:
        try:
            import asyncpg
        except ImportError as exc:  # pragma: no cover - dépendance de déploiement
            raise RuntimeError("Le paquet asyncpg est requis pour PostgreSQL") from exc

        async def configure_connection(connection: Any) -> None:
            await connection.set_type_codec(
                "jsonb",
                schema="pg_catalog",
                encoder=lambda value: json.dumps(value, separators=(",", ":"), ensure_ascii=False),
                decoder=json.loads,
            )

        self.pool = await asyncpg.create_pool(
            dsn=self._asyncpg_dsn(self.database_url),
            min_size=1,
            max_size=5,
            command_timeout=5,
            init=configure_connection,
        )
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS football_ai_api_cache (
                    cache_key TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    payload JSONB NOT NULL,
                    fetched_at TIMESTAMPTZ NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            await connection.execute(
                "CREATE INDEX IF NOT EXISTS football_ai_api_cache_expires_at_idx "
                "ON football_ai_api_cache (expires_at)"
            )

    async def get(self, key: str, allow_expired: bool = False) -> Optional[CacheEntry]:
        if self.pool is None:
            raise RuntimeError("Cache PostgreSQL non initialisé")
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                "SELECT payload, fetched_at, expires_at FROM football_ai_api_cache WHERE cache_key = $1",
                key,
            )
        if row is None:
            return None
        entry = CacheEntry(
            payload=row["payload"],
            fetched_at=row["fetched_at"],
            expires_at=row["expires_at"],
        )
        if entry.is_stale and not allow_expired:
            return None
        return entry

    async def set(
        self, key: str, payload: Any, ttl_seconds: int, provider: str
    ) -> CacheEntry:
        if self.pool is None:
            raise RuntimeError("Cache PostgreSQL non initialisé")
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=max(0, ttl_seconds))
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO football_ai_api_cache (cache_key, provider, payload, fetched_at, expires_at)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (cache_key) DO UPDATE SET
                    provider = EXCLUDED.provider,
                    payload = EXCLUDED.payload,
                    fetched_at = EXCLUDED.fetched_at,
                    expires_at = EXCLUDED.expires_at
                """,
                key,
                provider,
                payload,
                now,
                expires_at,
            )
        return CacheEntry(payload=payload, fetched_at=now, expires_at=expires_at)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None
