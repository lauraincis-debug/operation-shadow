#!/usr/bin/env bash
# 🚀 Mise à jour 1-clic de https://cloe-abidjan.web.app & https://jarvis-lv2.web.app
# (À lancer dans Google Cloud Shell si jarvis-lv2 utilise un autre compte Google que football-ai-43e33)
set -euo pipefail
WORK_DIR=$(mktemp -d)
echo "📥 Téléchargement de Cloé · Agent personnel · Abidjan × Omni-Sport & Football AI Ultra v6.4 Certifiée Intégrale..."
git clone --depth 1 -b arena/4139cd07-operation-shadow https://github.com/lauraincis-debug/operation-shadow.git "$WORK_DIR/repo"
cd "$WORK_DIR/repo/cloe-abidjan"
cat > firebase.json <<'EOF'
{
  "hosting": {
    "public": ".",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**", "*.sh", "FIREBASE_DEPLOY_REPORT.json"],
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "X-Content-Type-Options", "value": "nosniff" },
          { "key": "X-Frame-Options", "value": "DENY" },
          { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
          { "key": "Permissions-Policy", "value": "camera=(), geolocation=(), payment=(), usb=(), microphone=(self), display-capture=(self)" },
          { "key": "Content-Security-Policy", "value": "default-src 'self'; connect-src 'self' blob: data: https://site.api.espn.com https://site.web.api.espn.com https://www.thesportsdb.com https://www.scorebat.com https://generativelanguage.googleapis.com https://api.openai.com https://api.groq.com https://openrouter.ai https://api.anthropic.com https://raw.githubusercontent.com https://api.coingecko.com https://api.frankfurter.dev https://api.gdeltproject.org https://cdn.jsdelivr.net https://unpkg.com https://tessdata.projectnaptha.com https://football-ai-43e33.web.app https://cloe-ia-ultra.web.app; worker-src 'self' blob: https://cdn.jsdelivr.net; child-src 'self' blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://football-ai-43e33.web.app; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' blob: data: https:; frame-src https://www.scorebat.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self';" }
        ]
      },
      { "source": "/index.html", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
      { "source": "/sw.js", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
      { "source": "/cloe-bridge.js", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
      { "source": "/live-omni-snapshot.json", "headers": [{ "key": "Access-Control-Allow-Origin", "value": "*" }, { "key": "Cache-Control", "value": "public, max-age=120" }] }
    ],
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
EOF
echo "🚀 Déploiement sur Firebase (cloe-abidjan.web.app / jarvis-lv2)..."
npx -y firebase-tools deploy --only hosting --project jarvis-lv2 || npx -y firebase-tools deploy --only hosting --project cloe-abidjan
echo "✅ Terminé ! https://cloe-abidjan.web.app a reçu 100 % des données Omni-Sport & Football AI Ultra v6.4 Certifiée Intégrale !"
