#!/usr/bin/env node
/**
 * 🤖 DÉPLOIEMENT DIRECT SANS QUESTION DE CLOÉ IA ULTRA SUR FIREBASE HOSTING (jarvis-1v2)
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CLOE_WWW_DIR = path.join(ROOT_DIR, "cloe-www");

function walkLocalDir(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkLocalDir(full, baseDir));
    } else if (entry.isFile()) {
      const rel = "/" + path.relative(baseDir, full).split(path.sep).join("/");
      results.push({ fullPath: full, webPath: rel });
    }
  }
  return results;
}

async function apiJson(url, { method = "GET", token, quotaProject, body, rawBody, headers = {} } = {}) {
  const reqHeaders = {
    Authorization: `Bearer ${token}`,
    ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}),
    ...headers,
  };
  let payload = rawBody;
  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers: reqHeaders, body: payload });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function deployDirectRest(token, projectId, dirPath) {
  try {
    execSync(
      `gcloud services enable serviceusage.googleapis.com firebase.googleapis.com firebasehosting.googleapis.com --project=${projectId}`,
      { stdio: "ignore" }
    );
  } catch {
    // ignore if SA doesn't need enable
  }

  await apiJson(`https://firebase.googleapis.com/v1beta1/projects/${projectId}:addFirebase`, {
    method: "POST",
    token,
    quotaProject: projectId,
    body: {},
  });

  let targetSite = projectId;
  const sitesRes = await apiJson(
    `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites`,
    { token, quotaProject: projectId }
  );
  const existing = sitesRes.data?.sites || [];
  if (existing.length > 0) {
    const def = existing.find((s) => s.type === "DEFAULT_SITE") || existing[0];
    targetSite = def.name.split("/").pop();
  } else {
    const created = await apiJson(
      `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites?siteId=${projectId}`,
      { method: "POST", token, quotaProject: projectId, body: {} }
    );
    if (created.data?.name) targetSite = created.data.name.split("/").pop();
  }

  const allFiles = walkLocalDir(dirPath);
  const fileHashes = {};
  const gzipByHash = new Map();

  for (const f of allFiles) {
    const gz = zlib.gzipSync(fs.readFileSync(f.fullPath), { level: 9 });
    const sha = crypto.createHash("sha256").update(gz).digest("hex");
    fileHashes[f.webPath] = sha;
    gzipByHash.set(sha, gz);
  }

  const ver = await apiJson(
    `https://firebasehosting.googleapis.com/v1beta1/sites/${targetSite}/versions`,
    {
      method: "POST",
      token,
      quotaProject: projectId,
      body: {
        config: {
          rewrites: [{ glob: "**", path: "/index.html" }],
          headers: [{ glob: "/index.html", headers: { "Cache-Control": "no-cache" } }],
        },
      },
    }
  );
  if (!ver.ok || !ver.data?.name) {
    throw new Error(`Création version ${targetSite} refusée (${ver.status}) : ${JSON.stringify(ver.data)}`);
  }
  const versionName = ver.data.name;

  const pop = await apiJson(
    `https://firebasehosting.googleapis.com/v1beta1/${versionName}:populateFiles`,
    { method: "POST", token, quotaProject: projectId, body: { files: fileHashes } }
  );
  if (!pop.ok) {
    throw new Error(`populateFiles échoué (${pop.status}) : ${JSON.stringify(pop.data)}`);
  }

  const reqHashes = pop.data?.uploadRequiredHashes || [];
  const upUrl = pop.data?.uploadUrl;
  for (const h of reqHashes) {
    const up = await apiJson(`${upUrl}/${h}`, {
      method: "POST",
      token,
      quotaProject: projectId,
      rawBody: gzipByHash.get(h),
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!up.ok) throw new Error(`Upload ${h} échoué (${up.status})`);
  }

  const fin = await apiJson(
    `https://firebasehosting.googleapis.com/v1beta1/${versionName}?updateMask=status`,
    { method: "PATCH", token, quotaProject: projectId, body: { status: "FINALIZED" } }
  );
  if (!fin.ok) {
    throw new Error(`Finalisation échouée (${fin.status}) : ${JSON.stringify(fin.data)}`);
  }

  const rel = await apiJson(
    `https://firebasehosting.googleapis.com/v1beta1/sites/${targetSite}/releases?versionName=${encodeURIComponent(versionName)}`,
    {
      method: "POST",
      token,
      quotaProject: projectId,
      body: { message: "Cloé IA Ultra v4.0 — Assistante Personnelle Vocale & Auto-Évolutive" },
    }
  );
  if (!rel.ok) {
    throw new Error(`Release échouée (${rel.status}) : ${JSON.stringify(rel.data)}`);
  }
  return `https://${targetSite}.web.app`;
}

async function main() {
  const targetProjectId = process.argv[2] || "jarvis-1v2";
  console.log(`\n🤖 DÉPLOIEMENT AUTOMATIQUE DE CLOÉ IA ULTRA SUR "${targetProjectId}"...`);

  if (!fs.existsSync(CLOE_WWW_DIR)) {
    execSync("npm run build", { cwd: ROOT_DIR, stdio: "inherit" });
  }

  const token = execSync("gcloud auth print-access-token", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const liveUrl = await deployDirectRest(token, targetProjectId, CLOE_WWW_DIR);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ✨ CLOÉ IA ULTRA EST MAINTENANT EN LIGNE !                  ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  🤖 Lien direct Cloé : ${liveUrl}`);
  console.log("║  ⚡ Reliée en temps réel à : https://football-ai-43e33.web.app");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("⚠️ Erreur déploiement Cloé :", err.message);
  process.exit(1);
});
