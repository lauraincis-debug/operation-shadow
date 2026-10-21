#!/usr/bin/env bash
# 🚀 Mise à jour 1-clic de https://cloe-abidjan.web.app & https://jarvis-lv2.web.app
# (À lancer dans Google Cloud Shell si jarvis-lv2 utilise un autre compte Google que football-ai-43e33)
set -euo pipefail
WORK_DIR=$(mktemp -d)
echo "📥 Téléchargement de Cloé · Agent personnel · Abidjan × Football AI Ultra v5..."
git clone --depth 1 -b arena/4139cd07-operation-shadow https://github.com/lauraincis-debug/operation-shadow.git "$WORK_DIR/repo"
cd "$WORK_DIR/repo/cloe-abidjan"
cat > firebase.json <<'EOF'
{
  "hosting": {
    "public": ".",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**", "*.sh", "FIREBASE_DEPLOY_REPORT.json"],
    "headers": [
      { "source": "/index.html", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
      { "source": "/sw.js", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
      { "source": "/cloe-bridge.js", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] }
    ],
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
EOF
echo "🚀 Déploiement sur Firebase (cloe-abidjan.web.app / jarvis-lv2)..."
npx -y firebase-tools deploy --only hosting --project jarvis-lv2 || npx -y firebase-tools deploy --only hosting --project cloe-abidjan
echo "✅ Terminé ! https://cloe-abidjan.web.app a reçu 100 % des données Football AI Ultra v5 !"
