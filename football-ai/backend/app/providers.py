from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

import httpx

from .cache import CacheEntry, MemoryJsonCache
from .settings import Settings


class ProviderUnavailable(RuntimeError):
    """Erreur amont assainie : ne contient jamais la clé d'API."""


@dataclass(frozen=True)
class ProviderResponse:
    payload: dict[str, Any]
    fetched_at: datetime
    is_live_network: bool
    is_cached: bool
    is_stale: bool

    @property
    def fetched_at_iso(self) -> str:
        return self.fetched_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class ProviderGateway:
    def __init__(self, settings: Settings, cache: Any, client: httpx.AsyncClient):
        self.settings = settings
        self.cache = cache
        self.client = client

    @staticmethod
    def _cache_key(
        provider: str,
        url: str,
        params: Optional[Mapping[str, Any]],
        credential: str,
    ) -> str:
        credential_fingerprint = hashlib.sha256(credential.encode("utf-8")).hexdigest()[:12]
        identity = json.dumps(
            {
                "provider": provider,
                "url": url,
                "params": dict(params or {}),
                "credential": credential_fingerprint,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return f"{provider}:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"

    @staticmethod
    def _from_cache(entry: CacheEntry, *, stale: bool) -> ProviderResponse:
        return ProviderResponse(
            payload=entry.payload,
            fetched_at=entry.fetched_at,
            is_live_network=False,
            is_cached=True,
            is_stale=stale,
        )

    async def request_json(
        self,
        *,
        provider: str,
        url: str,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        credential: str = "",
        ttl_seconds: int,
        force_refresh: bool = False,
    ) -> ProviderResponse:
        cache_key = self._cache_key(provider, url, params, credential)
        if not force_refresh:
            try:
                cached = await self.cache.get(cache_key)
            except Exception:
                cached = None
            if cached is not None:
                return self._from_cache(cached, stale=False)

        try:
            response = await self.client.get(url, params=params, headers=headers)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ProviderUnavailable(f"Réponse {provider} invalide")
            try:
                entry = await self.cache.set(
                    cache_key,
                    payload,
                    ttl_seconds,
                    provider=provider,
                )
            except Exception:
                entry = CacheEntry(
                    payload=payload,
                    fetched_at=datetime.now(timezone.utc),
                    expires_at=datetime.now(timezone.utc),
                )
            return ProviderResponse(
                payload=payload,
                fetched_at=entry.fetched_at,
                is_live_network=True,
                is_cached=False,
                is_stale=False,
            )
        except (httpx.HTTPError, ValueError, ProviderUnavailable) as exc:
            try:
                stale = await self.cache.get(cache_key, allow_expired=True)
            except Exception:
                stale = None
            if stale is not None and stale.age_seconds <= (
                ttl_seconds + self.settings.stale_if_error_seconds
            ):
                return self._from_cache(stale, stale=True)
            raise ProviderUnavailable(f"Le fournisseur {provider} est momentanément indisponible") from exc


def football_data_headers(settings: Settings) -> dict[str, str]:
    return {"X-Auth-Token": settings.football_data_api_key}


def api_football_headers(settings: Settings) -> dict[str, str]:
    return {"x-apisports-key": settings.api_football_key}
