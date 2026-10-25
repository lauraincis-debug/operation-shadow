# ⚡ FOOTBALL AI ULTRA v6.4

🌐 **Application en production :** [https://football-ai-43e33.web.app](https://football-ai-43e33.web.app)

Application web & PWA d'analyse tactique, de prédiction footballistique et d'apprentissage. Le site statique est construit dans `www/` et hébergé sur Firebase Hosting (`football-ai-43e33`).

> Les estimations de probabilité ne garantissent aucun résultat ni gain. La performance prospective reste affichée « — » avant 30 pronostics admissibles, horodatés avant le match et résolus par un résultat officiel.

---

## Modules

1. **📡 Matchs Live** (`src/services/liveMatchesApi.js`) : catalogue de 42 flux ESPN couvrant 7 sports, disponible sans clé, complété par Football-Data.org quand son connecteur serveur est configuré. Les snapshots et caches sont identifiés et ne valident jamais un statut Live.
2. **⚽ Prédire** (`src/engine/predictor.js`) : 167 équipes, Poisson bivarié/Dixon-Coles, Elo dynamique et marchés cohérents. Les données de calibration synthétiques sont exclues de la performance publiée.
3. **⚔️ Face-à-Face** (`src/components/HeadToHeadTab.jsx`) : comparaisons et historique uniquement lorsque des résultats sourcés sont disponibles.
4. **🎥 Vidéo IA** (`src/engine/videoAnalyzer.js`) : recherche et analyse vidéo bloquées sans revalidation récente du statut officiel « en cours »; toute rencontre terminée est rejetée.
5. **👑 Fantasy IA** : simulation d'équipe sous budget, sans garantie de résultat.
6. **🎯 Coupon** : les cotes de ticket doivent provenir d'un flux identifié, d'une saisie manuelle ou d'une capture vérifiée. Les cotes estimées ne deviennent jamais des cotes bookmaker; un ticket automatique sans deux sélections à cote réelle s'abstient (NO-BET). Les anciens coupons restent visibles avec le statut « non vérifiée » jusqu'à ressaisie. Aucune mise n'est automatisée.
7. **📋 Historique / 📊 Performance** : seules les prédictions pré-match évaluables et les données officielles sont comptées. Le rejeu d'apprentissage est séparé du taux prospectif.
8. **Bulle Performance & apprentissage** : accessible depuis toutes les pages; elle distingue le taux réellement mesuré, la taille d'échantillon et les résultats intégrés à l'apprentissage.

---

## Architecture des données et secrets

Le backend FastAPI est dans `backend/`. Les appels Football-Data.org et API-Football ne partent jamais de React : leurs clés sont lues exclusivement dans l'environnement du serveur et aucune clé fournisseur ne doit être placée dans `VITE_*`.

Cloé et le scanner peuvent proposer, en option, une clé LLM personnelle saisie par l'utilisateur. Elle reste uniquement en mémoire pendant la session, n'est plus écrite dans `localStorage` et n'est pas nécessaire au fonctionnement de base. Si l'utilisateur l'active, la requête part directement vers le fournisseur choisi et peut être soumise à ses quotas ou frais; l'OCR local et le moteur de base restent disponibles sans cette clé. Les anciennes clés LLM enregistrées par les versions précédentes sont supprimées au prochain chargement de Cloé.

Routes principales :

- `GET /api/health` — état des fournisseurs et du cache, sans révéler de secret;
- `GET /api/football/fixtures?date=AAAA-MM-JJ` — matchs Football-Data.org;
- `GET /api/football/results?dateFrom=AAAA-MM-JJ&dateTo=AAAA-MM-JJ` — résultats terminés;
- `GET /api/football/standings/{code}` — classement Football-Data.org;
- `GET /api/football/matches/{id}?revalidate=true` — revalidation à la demande pour une vérification Live;
- `GET /api/football/player-stats?team_name=…&season=…&league_id=…` — résolution du nom d'équipe exacte côté serveur puis statistiques joueurs API-Football, si configuré; `team_id` peut aussi être fourni directement.

Les réponses fournisseurs sont mises en cache dans PostgreSQL/JSONB avec TTL différenciés (fixtures, résultats, classements et joueurs). En absence de `DATABASE_URL`, le backend démarre avec un cache mémoire de repli : il ne faut pas le confondre avec le cache PostgreSQL de production. En cas d'erreur fournisseur, une réponse périmée peut être rendue comme archive, mais elle est explicitement marquée `isSnapshot`/`isCached`; elle ne peut ni certifier le direct ni autoriser une vidéo. Le Service Worker contourne entièrement le cache et le mode hors ligne pour `/api/*`.

Une limite locale par adresse cliente renvoie HTTP 429 sur `/api/*`, sauf `/api/health`. Elle est conservée en mémoire par processus et n'est pas partagée entre instances Cloud Run : c'est un frein aux rafales, pas un quota global ni une protection garantie contre l'épuisement des quotas amont. Uvicorn fait confiance aux en-têtes proxy configurés pour Cloud Run; ne pas réutiliser cette configuration derrière un proxy non fiable. Aucun service payant de limitation distribuée n'a été ajouté.

**Connecteurs optionnels :** `FOOTBALL_DATA_API_KEY`, `API_FOOTBALL_KEY`, `DATABASE_URL`. L'usage de base reste sans compte ni clé grâce aux flux ESPN publics. Les quotas des fournisseurs à clé restent soumis aux offres de ces fournisseurs; le cache PostgreSQL réduit les requêtes répétées.

---

## Développement local

Lancer le backend dans un premier terminal :

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Lancer l'interface dans un second terminal, depuis `football-ai/` :

```bash
npm install
npm run dev
```

Vite relaie `/api/*` vers `http://127.0.0.1:8000` côté serveur de développement; le navigateur utilise uniquement des URL relatives. Pour modifier la cible du proxy, définir `VITE_API_TARGET` (ce n'est pas une clé API).

Pour activer les fournisseurs en local, définir les variables dans l'environnement du processus Uvicorn. `backend/.env.example` est un modèle sans secret; l'application ne lit pas automatiquement les fichiers `.env`.

```bash
npm run test:model
npm run test:regressions
npm run build
(cd backend && pytest -q)
```

Le build écrit dans `www/` et `cloe-www/` et génère les données Cloé. Un avertissement de taille de bundle Vite n'empêche pas la compilation.

---

## Déploiement

`firebase.json` relaie `/api/**` vers le service Cloud Run `football-ai-api` en `europe-west1`; le reste du trafic va au site statique. Cette règle ne crée ni ne déploie le service Cloud Run. **Le backend n'est pas encore déployé** : les routes `/api` de production ne seront opérationnelles qu'après provisionnement de ce service, de ses secrets côté serveur et d'une base PostgreSQL accessible. Aucun déploiement n'est effectué par les commandes de test/build.

Procédure d'exploitation attendue :

1. Créer une instance PostgreSQL et la base `football_ai`; configurer l'accès réseau Cloud Run et fournir `DATABASE_URL` via Secret Manager.
2. Enregistrer les clés optionnelles dans Secret Manager (`FOOTBALL_DATA_API_KEY`, `API_FOOTBALL_KEY`), sans les inscrire dans le dépôt, Firebase Hosting ou des variables `VITE_*`.
3. Construire et déployer `backend/Dockerfile` sous le nom de service `football-ai-api`, région `europe-west1`, avec accès non authentifié pour préserver l'accès public; appliquer les restrictions réseau/quota adaptées.
4. Déployer ensuite le site Firebase. Vérifier `/api/health`, les tests de connecteur et la disponibilité PostgreSQL avant d'annoncer le service opérationnel.

Le site web principal est `football-ai-43e33.web.app`; Cloé reste séparée et conserve ses URL/identités visuelles existantes. Le pont Express Betclic reste indépendant et en attente de confirmation.
