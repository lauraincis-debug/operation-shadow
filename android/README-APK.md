# Operation Shadow — Build APK

Le bac à sable n'a pas Java / Android SDK. Ce dossier contient le projet source propre.

## Pour obtenir le `.apk`

1. Copie/ouvre le dossier `android/` dans **Android Studio** (sur ton PC / Mac).
2. Attends la syncro Gradle (la première fois télécharge le SDK automatiquement si tu l'as installé via Studio).
3. **Build → Build Bundle(s) / APK(s) → Build APK(s)**
4. Le fichier `app-release-unsigned.apk` (ou signé si tu configures une clé) va dans `android/app/build/outputs/apk/release/`.
5. Transfère le `.apk` sur ton téléphone et installe (active « Sources inconnues » si nécessaire).

Le jeu est intégré dans `assets/www/` : `index.html` charge le moteur Canvas directement dans le WebView natif, aucun serveur externe requis.

Remarque : le `README.md` d'origine du dépôt est conservé intact (pas altéré pour l'APK).
