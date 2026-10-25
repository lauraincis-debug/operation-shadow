# Backend Football AI (FastAPI)

Passerelle serveur vers Football-Data.org v4 et API-Football. Les clés sont lues depuis l'environnement et ne figurent ni dans les requêtes React, ni dans les réponses d'état.

## Routes

- `GET /api/health`
- `GET /api/football/fixtures?date=AAAA-MM-JJ`
- `GET /api/football/results?dateFrom=AAAA-MM-JJ&dateTo=AAAA-MM-JJ` (période maximale : 31 jours)
- `GET /api/football/standings/{code}?season=2026`
- `GET /api/football/matches/{id}?revalidate=true`
- `GET /api/football/player-stats?team_name=Arsenal%20FC&season=2026&league_id=39` (résolution de nom exacte côté serveur) ou `team_id=42`

## Lancement

Depuis ce dossier :

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Le client Vite de l'application relaie `/api` vers ce service. L'URL `127.0.0.1` ne sert qu'à la configuration interne du proxy côté serveur de développement; le navigateur appelle une URL relative.

## Configuration

Variables serveur :

- `FOOTBALL_DATA_API_KEY` — optionnelle; matchs, résultats, classements et validation de statut Football-Data.org;
- `API_FOOTBALL_KEY` — optionnelle; statistiques de joueurs API-Football;
- `DATABASE_URL` — URL PostgreSQL (`postgresql://…` ou `postgresql+asyncpg://…`).

Options supplémentaires : `UPSTREAM_TIMEOUT_SECONDS`, `FOOTBALL_FIXTURES_TTL_SECONDS`, `FOOTBALL_RESULTS_TTL_SECONDS`, `FOOTBALL_STANDINGS_TTL_SECONDS`, `PLAYER_STATS_TTL_SECONDS`, `STALE_IF_ERROR_SECONDS` et `CORS_ALLOW_ORIGINS`.

`.env.example` est un exemple; le service ne charge pas de `.env`. Préférer les variables d'environnement locales ou Secret Manager en production. Ne jamais ajouter un vrai secret au dépôt.

## Cache et statuts Live

PostgreSQL crée automatiquement `football_ai_api_cache` (JSONB, horodatage et expiration) et un index d'expiration. Si PostgreSQL n'est pas configuré ou inaccessible au démarrage, un cache mémoire de repli permet au service de démarrer, et `/api/health` l'indique.

Les cache hits n'ont jamais `isLiveNetwork=true`. Après une panne amont, une entrée expirée peut être renvoyée à titre informatif avec `isSnapshot=true`; un statut en cours y est neutralisé. La route de revalidation Live ignore le cache normal; un cache périmé de secours ne peut donc pas passer le contrôle vidéo. Le Service Worker de l'application contourne le cache et le fallback hors ligne pour `/api/*`.

## Tests

```bash
pytest -q
```

Les tests utilisent un transport HTTP simulé et le cache mémoire. Ils vérifient l'absence de secret dans le navigateur/réponse, les routes et l'invalidation d'un statut Live en cache. Une base PostgreSQL réelle reste nécessaire pour un test d'intégration du schéma et du cache partagé.
