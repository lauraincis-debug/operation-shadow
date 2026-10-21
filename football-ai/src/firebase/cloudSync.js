// ============================================================================
// SYNCHRONISATION FIREBASE REALTIME CLOUD SÉCURISÉE v6.2 (E2EE VÉRITABLE)
// Correctifs Audit #2 [AUDIT2-SEC-02] :
// 1. Interdiction de dériver la clé AES-256 à partir de `syncRoom` (qui figure dans l'URL) !
//    Un mot de passe secret distinct (`encryptionPassphrase`, >= 8 caractères) est exigé.
// 2. Anti-Downgrade : si un mot de passe E2EE est fourni, tout paquet distant non chiffré
//    (`encrypted !== true`) est immédiatement rejeté comme tentative d'empoisonnement !
// 3. Encodage Base64 par blocs de 32 Ko (zéro `Maximum call stack size exceeded`).
// ============================================================================

const SYNC_CFG_KEY = "football_ai_firebase_sync_cfg";

export function loadFirebaseSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CFG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {
    databaseUrl: import.meta.env.VITE_FIREBASE_DATABASE_URL || "",
    syncRoom: "",
    authToken: "",
    encryptionPassphrase: "",
  };
}

export function saveFirebaseSyncConfig(cfg) {
  try {
    // Ne jamais enregistrer le mot de passe maître en clair sur disque partagé
    const { encryptionPassphrase: _ignored, ...safeToPersist } = cfg || {};
    localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(safeToPersist));
  } catch {
    // ignore
  }
}

function buildEndpoint(databaseUrl, syncRoom, authToken = "") {
  const cleanUrl = String(databaseUrl || "").trim().replace(/\/+$/, "");
  const cleanRoom = String(syncRoom || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  if (!cleanUrl.startsWith("https://")) {
    throw new Error("URL Firebase Realtime Database invalide (doit commencer par https://).");
  }
  if (!cleanRoom || cleanRoom.length < 8) {
    throw new Error(
      "Sécurité Cloud : choisissez un identifiant de coffre d'au moins 8 caractères."
    );
  }
  const query = authToken?.trim() ? `?auth=${encodeURIComponent(authToken.trim())}` : "";
  return `${cleanUrl}/football_ai_profiles_v6/${cleanRoom}.json${query}`;
}

async function deriveAesKey(passphrase, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 120000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encodage par blocs sûrs (évite tout dépassement de pile sur gros historiques > 64 Ko)
function toB64(bytes) {
  const u8 = new Uint8Array(bytes);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function validateSecretPassphrase(passphrase, syncRoom) {
  const secret = String(passphrase || "").trim();
  if (!secret || secret.length < 8) {
    throw new Error(
      "Sécurité E2EE obligatoire : saisissez un mot de passe secret d'au moins 8 caractères (distinct du nom du coffre)."
    );
  }
  if (secret.toLowerCase() === String(syncRoom || "").trim().toLowerCase()) {
    throw new Error(
      "Sécurité E2EE : le mot de passe de chiffrement doit être différent du nom du coffre URL !"
    );
  }
  return secret;
}

export function validateE2eePassphrase(syncRoom, passphrase) {
  try {
    validateSecretPassphrase(passphrase, syncRoom);
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

export async function pushStateToFirebase(
  databaseUrl,
  syncRoom,
  payload,
  options = {}
) {
  const endpoint = buildEndpoint(databaseUrl, syncRoom, options.authToken);
  const secret = validateSecretPassphrase(options.encryptionPassphrase, syncRoom);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(secret, salt);
  const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);

  const bodyObj = {
    version: "6.2-e2ee-strict",
    encrypted: true,
    updatedAt: new Date().toISOString(),
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(cipherBuf),
  };

  const res = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) {
    throw new Error(`Erreur Firebase (${res.status}) : vérifiez l'URL, le jeton Auth ou les règles.`);
  }
  return res.json();
}

export async function pullStateFromFirebase(databaseUrl, syncRoom, options = {}) {
  const endpoint = buildEndpoint(databaseUrl, syncRoom, options.authToken);
  const secret = validateSecretPassphrase(options.encryptionPassphrase, syncRoom);

  const res = await fetch(endpoint, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Erreur Firebase (${res.status}) lors de la récupération.`);
  }
  const raw = await res.json();
  if (!raw) {
    throw new Error("Aucune sauvegarde trouvée sur cet identifiant de coffre.");
  }

  // Protection stricte contre toute attaque par rétrogradation ("encrypted: false")
  if (!raw.encrypted || !raw.ciphertext || !raw.salt || !raw.iv) {
    throw new Error(
      "⛔ Alerte Sécurité E2EE : sauvegarde distante non chiffrée ou altérée — chargement bloqué pour protéger le modèle !"
    );
  }

  let data;
  try {
    const key = await deriveAesKey(secret, fromB64(raw.salt));
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(raw.iv) },
      key,
      fromB64(raw.ciphertext)
    );
    data = JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    throw new Error("Mot de passe secret E2EE incorrect ou données altérées (échec AES-256-GCM).");
  }

  if (!data || !Array.isArray(data.predictions)) {
    throw new Error("Format de sauvegarde Cloud invalide — rejeté par sécurité.");
  }
  return data;
}
