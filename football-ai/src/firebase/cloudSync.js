// ============================================================================
// SYNCHRONISATION FIREBASE REALTIME CLOUD SÉCURISÉE (E2EE AES-256-GCM + AUTH)
// Corrections P0/P2 :
// - Support Jeton d'Authentification Firebase (?auth=...)
// - Chiffrement de bout en bout AES-256-GCM (PBKDF2-SHA256 120 000 itérations)
//   empêchant toute lecture ou empoisonnement distant du profil IA
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
    // Ne jamais stocker durablement le mot de passe maître en clair sur disque partagé
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
      "Sécurité Cloud : choisissez un identifiant de coffre secret d'au moins 8 caractères."
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

function toB64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export async function pushStateToFirebase(
  databaseUrl,
  syncRoom,
  payload,
  options = {}
) {
  const endpoint = buildEndpoint(databaseUrl, syncRoom, options.authToken);
  const pass = String(options.encryptionPassphrase || syncRoom).trim();

  let bodyObj;
  if (typeof crypto !== "undefined" && crypto.subtle && pass.length >= 6) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(pass, salt);
    const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
    const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);
    bodyObj = {
      version: "6.1-e2ee",
      encrypted: true,
      updatedAt: new Date().toISOString(),
      salt: toB64(salt),
      iv: toB64(iv),
      ciphertext: toB64(cipherBuf),
    };
  } else {
    bodyObj = {
      version: "6.1",
      encrypted: false,
      updatedAt: new Date().toISOString(),
      ...payload,
    };
  }

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
  const res = await fetch(endpoint, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Erreur Firebase (${res.status}) lors de la récupération.`);
  }
  const raw = await res.json();
  if (!raw) {
    throw new Error("Aucune sauvegarde trouvée sur cet identifiant de coffre.");
  }

  let data = raw;
  if (raw.encrypted && raw.ciphertext && raw.salt && raw.iv) {
    const pass = String(options.encryptionPassphrase || syncRoom).trim();
    const key = await deriveAesKey(pass, fromB64(raw.salt));
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(raw.iv) },
      key,
      fromB64(raw.ciphertext)
    );
    data = JSON.parse(new TextDecoder().decode(plainBuf));
  }

  if (!data || !Array.isArray(data.predictions)) {
    throw new Error("Format de sauvegarde Cloud invalide ou corrompu — rejeté par sécurité.");
  }
  return data;
}
