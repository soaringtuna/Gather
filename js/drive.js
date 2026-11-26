const CLIENT_ID = "648436035100-aicrildqc4nhu4sopsb51j2mcsiueb2m.apps.googleusercontent.com";
const API_KEY = "AIzaSyDpSdju5nqiZhFg55rTYfR-eTBlP9ZaZ0o";
const APP_ID = "648436035100";
const DRIVE = "https://www.googleapis.com/auth/drive";
const IDENTITY = "openid email profile";
const RETURN_PAGE = "/google-return.html";
const PENDING_KEY = "class-record-google-pending";
const RETURN_KEY = "class-record-google-return";
const ACCESS_KEY = "class-record-google-access";
const ACCOUNT_KEY = "class-record-google-account";
const ERROR_KEY = "class-record-google-error";
const ID_KEY = "class-record-google-id";
let refreshTimer = 0;
let restorePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded === "1") {
      resolve();
      return;
    }
    const script = existing || document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "1";
      resolve();
    };
    script.onerror = () => reject(new Error("Google Drive could not be loaded."));
    if (!existing) document.head.append(script);
  });
}

export function prepareGoogle() {
  return loadScript("https://apis.google.com/js/api.js").then(() => new Promise((resolve, reject) => {
    if (!window.gapi) {
      reject(new Error("Google Drive could not be loaded."));
      return;
    }
    if (window.google?.picker) {
      resolve();
      return;
    }
    window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Drive could not be loaded.")) });
  }));
}

function redirectFor(scope, pending, prompt) {
  sessionStorage.setItem(PENDING_KEY, pending);
  sessionStorage.setItem(RETURN_KEY, `${location.pathname}${location.search}${location.hash}`);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", location.origin + RETURN_PAGE);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("scope", scope);
  url.searchParams.set("include_granted_scopes", "true");
  const email = googleAccountEmail();
  if (email) url.searchParams.set("login_hint", email);
  if (prompt) url.searchParams.set("prompt", prompt);
  location.assign(url);
  return Promise.resolve();
}

export function beginGoogleSignIn() {
  return redirectFor(IDENTITY, "email", "select_account");
}

function readStored(key) {
  return localStorage.getItem(key) || sessionStorage.getItem(key) || "";
}

export function googleAccountEmail() {
  const email = readStored(ACCOUNT_KEY);
  if (email && localStorage.getItem(ACCOUNT_KEY) !== email) localStorage.setItem(ACCOUNT_KEY, email);
  return email;
}

export function rememberGoogleAccount(email) {
  const clean = String(email || "").trim();
  if (!clean) return;
  localStorage.setItem(ACCOUNT_KEY, clean);
  sessionStorage.setItem(ACCOUNT_KEY, clean);
}

function readAccessRecord() {
  try {
    const raw = readStored(ACCESS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved?.token) return null;
    if (localStorage.getItem(ACCESS_KEY) !== raw) localStorage.setItem(ACCESS_KEY, raw);
    return saved;
  } catch {
    return null;
  }
}

function writeAccess(saved) {
  const raw = JSON.stringify(saved);
  localStorage.setItem(ACCESS_KEY, raw);
  sessionStorage.setItem(ACCESS_KEY, raw);
  scheduleRefresh(saved);
  window.dispatchEvent(new Event("google-access-ready"));
}

function markAccessExpired() {
  const saved = readAccessRecord();
  clearTimeout(refreshTimer);
  if (saved) {
    saved.expires = 0;
    const raw = JSON.stringify(saved);
    localStorage.setItem(ACCESS_KEY, raw);
    sessionStorage.setItem(ACCESS_KEY, raw);
  }
  window.dispatchEvent(new Event("google-access-ended"));
}

function scheduleRefresh(saved) {
  clearTimeout(refreshTimer);
  if (!saved?.expires) return;
  const delay = Math.max(5000, saved.expires - Date.now() - 60000);
  refreshTimer = setTimeout(() => {
    const email = googleAccountEmail();
    const previous = readAccessRecord();
    const wanted = String(previous?.scope || "");
    const scope = wanted.split(/\s+/).includes(DRIVE) ? `${IDENTITY} ${DRIVE}` : IDENTITY;
    silentToken(scope, email).then((saved) => {
      if (!saved && scope !== IDENTITY) return silentToken(IDENTITY, email);
      return saved;
    });
  }, delay);
}

export function storedGoogleToken() {
  const saved = readAccessRecord();
  if (!saved?.token || saved.expires < Date.now() + 15000) return null;
  scheduleRefresh(saved);
  return saved;
}

function loadGsi() {
  return loadScript("https://accounts.google.com/gsi/client");
}

function silentToken(scope, email) {
  return loadGsi().then(() => new Promise((resolve) => {
    if (!window.google?.accounts?.oauth2) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope,
      include_granted_scopes: true,
      hint: email || undefined,
      callback: (response) => {
        if (!response || response.error || !response.access_token) {
          finish(null);
          return;
        }
        const saved = {
          token: response.access_token,
          scope: response.scope || scope,
          expires: Date.now() + (Number(response.expires_in) || 3600) * 1000,
        };
        writeAccess(saved);
        finish(saved);
      },
      error_callback: () => finish(null),
    });
    setTimeout(() => finish(null), 8000);
    try {
      client.requestAccessToken({ prompt: "" });
    } catch {
      finish(null);
    }
  }));
}

export function restoreGoogleSession() {
  const current = storedGoogleToken();
  if (current) return Promise.resolve(current);
  if (restorePromise) return restorePromise;
  const previous = readAccessRecord();
  const email = googleAccountEmail();
  if (!previous && !email) return Promise.resolve(null);
  const wanted = String(previous?.scope || "");
  const scope = wanted.split(/\s+/).includes(DRIVE) ? `${IDENTITY} ${DRIVE}` : IDENTITY;
  restorePromise = silentToken(scope, email).then((saved) => {
    if (saved || scope === IDENTITY) return saved;
    return silentToken(IDENTITY, email);
  }).finally(() => {
    restorePromise = null;
  });
  return restorePromise;
}

export function canListDrive(scope = "") {
  return String(scope).split(/\s+/).includes(DRIVE);
}

export function beginDriveFolder() {
  const saved = storedGoogleToken();
  if (canListDrive(saved?.scope || "")) return Promise.resolve(false);
  return redirectFor(`${IDENTITY} ${DRIVE}`, "folder", "consent").then(() => true);
}

function emailFromIdToken(idToken) {
  try {
    const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(payload));
    return json.email || "";
  } catch {
    return "";
  }
}

async function accountEmail(token, idToken) {
  const fromToken = emailFromIdToken(idToken);
  if (fromToken) return fromToken;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return "";
  const info = await response.json();
  return info.email || "";
}

export async function takeGoogleResult() {
  const pending = sessionStorage.getItem(PENDING_KEY);
  const error = sessionStorage.getItem(ERROR_KEY);
  if (!pending && !error) return null;
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(ERROR_KEY);
  if (error) {
    const closed = error === "access_denied" || error === "popup_closed_by_user";
    return { pending: pending || "email", error: closed ? "Google sign-in was closed." : "Google did not allow the folder list." };
  }
  const saved = storedGoogleToken();
  const idToken = sessionStorage.getItem(ID_KEY) || "";
  sessionStorage.removeItem(ID_KEY);
  if (!saved) return { pending: pending || "email", error: "Google sign-in did not finish." };
  try {
    const email = await accountEmail(saved.token, idToken);
    return { pending, email, token: saved };
  } catch {
    return { pending, error: "The Google account email could not be read.", token: saved };
  }
}

async function driveFailure(response, fallback) {
  if (response.status === 401) markAccessExpired();
  return new Error(await driveMessage(response, fallback));
}

async function driveMessage(response, fallback = "The backup could not be saved.") {
  try {
    const body = await response.json();
    return String(body.error?.message || fallback).slice(0, 140);
  } catch {
    return fallback;
  }
}

const PICKER_KEY = "class-record-google-picker";

function folderParent(parentId) {
  return String(parentId || "root").replace(/'/g, "");
}

export async function listFolders(token, parentId, pageToken = "") {
  const parent = folderParent(parentId);
  const q = `mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents and trashed = false`;
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "nextPageToken,files(id,name)");
  url.searchParams.set("orderBy", "name");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("spaces", "drive");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await driveFailure(response);
  const body = await response.json();
  return {
    folders: (body.files || []).map((file) => ({ id: file.id, name: file.name || "Folder" })),
    nextPageToken: body.nextPageToken || "",
  };
}

export async function createDriveFolder(token, parentId, name) {
  const clean = String(name || "").trim().slice(0, 120);
  if (!clean) throw new Error("Type a folder name.");
  const response = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: clean,
      mimeType: "application/vnd.google-apps.folder",
      parents: [folderParent(parentId)],
    }),
  });
  if (!response.ok) throw await driveFailure(response);
  const folder = await response.json();
  return { id: folder.id, name: folder.name || clean };
}

function driveQueryName(name) {
  return String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function uploadCsv(token, folderId, name, csv) {
  const query = `name = '${driveQueryName(name)}' and '${folderId}' in parents and trashed = false`;
  const listed = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listed.ok) throw await driveFailure(listed);
  const existing = (await listed.json()).files?.[0];
  const boundary = `class-record-${Date.now()}`;
  const meta = existing ? { name } : { name, parents: [folderId] };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--`;
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const saved = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!saved.ok) throw await driveFailure(saved);
}

export function takePickedFolder() {
  const raw = sessionStorage.getItem(PICKER_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PICKER_KEY);
  if (raw === "cancel" || raw === "no-token" || raw === "error") return { cancelled: true, reason: raw };
  try {
    const folder = JSON.parse(raw);
    if (!folder?.id) return { cancelled: true };
    return { folder };
  } catch {
    return { cancelled: true };
  }
}

export async function uploadToFolder(token, folderId, name, csv) {
  await uploadCsv(token, folderId, name, csv);
}

export async function listCsvFiles(token, folderId) {
  const parent = folderParent(folderId);
  const q = `'${parent}' in parents and trashed = false`;
  const files = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType)");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("spaces", "drive");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await driveFailure(response, "The class files could not be read.");
    const body = await response.json();
    for (const file of body.files || []) {
      const name = String(file.name || "");
      if (!name.toLowerCase().endsWith(".csv")) continue;
      if (String(file.mimeType || "").startsWith("application/vnd.google-apps.")) continue;
      files.push({ id: file.id, name });
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return files;
}

export async function downloadDriveFile(token, fileId) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await driveFailure(response, "The class files could not be read.");
  return response.text();
}
