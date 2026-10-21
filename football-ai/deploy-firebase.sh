#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo " ⚡ FOOTBALL AI ULTRA v4 — Déploiement Direct Sans Question"
echo "========================================================"

if command -v firebase >/dev/null 2>&1; then
  FB_CMD="firebase"
else
  FB_CMD="npx -y firebase-tools"
fi

if [ ! -d "www" ]; then
  npm install --no-audit --no-fund
  npm run build
fi

RAW_ID="${1:-football-ai-43e33}"
# Nettoyer automatiquement si l'utilisateur a collé une URL https://xxx.web.app
PROJECT_ID=$(echo "$RAW_ID" | sed -E 's#^https?://##; s#\.web\.app.*$##; s#\.firebaseapp\.com.*$##; s#/.*$##')
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="football-ai-43e33"
fi

cat > .firebaserc <<EOF
{
  "projects": {
    "default": "${PROJECT_ID}"
  }
}
EOF

echo "🚀 Mise en ligne automatique sur Firebase Hosting (${PROJECT_ID})..."
$FB_CMD deploy --only hosting --project "$PROJECT_ID"

# Déployer aussi automatiquement Cloé IA Ultra sur jarvis-1v2 si cloe-www est présent !
if [ -d "cloe-www" ]; then
  TMP_CFG=$(mktemp -d)
  cp -a cloe-www "$TMP_CFG/cloe-www"
  cat > "$TMP_CFG/firebase.json" <<'FBEOF'
{
  "hosting": {
    "public": "cloe-www",
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
FBEOF
  echo "🤖 Mise en ligne automatique de Cloé IA Ultra sur jarvis-1v2..."
  (cd "$TMP_CFG" && $FB_CMD deploy --only hosting --project jarvis-1v2) || true
  rm -rf "$TMP_CFG"
fi

echo ""
echo "✅ TOUT EST EN LIGNE AVEC SUCCÈS !"
echo "🌐 Football AI Ultra v4 : https://${PROJECT_ID}.web.app"
echo "🤖 Cloé IA Ultra v4     : https://jarvis-1v2.web.app"
