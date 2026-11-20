const CLIENT_ID = "648436035100-aicrildqc4nhu4sopsb51j2mcsiueb2m.apps.googleusercontent.com";
const API_KEY = "AIzaSyDpSdju5nqiZhFg55rTYfR-eTBlP9ZaZ0o";
const APP_ID = "648436035100";
const DRIVE = "https://www.googleapis.com/auth/drive";
const IDENTITY = "openid email profile";
const RETURN_PAGE = "/google-return.html";
const PENDING_KEY = "class-record-google-pending";
const RETURN_KEY = "class-record-google-return";
const ACCESS_KEY = "class-record-google-access";
const ERROR_KEY = "class-record-google-error";
const ID_KEY = "class-record-google-id";

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
  const email = sessionStorage.getItem("class-record-google-account");
  if (email) url.searchParams.set("login_hint", email);
  if (prompt) url.searchParams.set("prompt", prompt);
  location.assign(url);
  return Promise.resolve();
}

export function beginGoogleSignIn() {
  return redirectFor(IDENTITY, "email", "select_account");
}

export function storedGoogleToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ACCESS_KEY) || "");
    if (!saved?.token || saved.expires < Date.now() + 15000) return null;
    return saved;
  } catch {
    return null;
  }
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

async function driveMessage(response) {
  try {
    const body = await response.json();
    return String(body.error?.message || "The backup could not be saved.").slice(0, 140);
  } catch {
    return "The backup could not be saved.";
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
  if (!response.ok) throw new Error(await driveMessage(response));
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
  if (!response.ok) throw new Error(await driveMessage(response));
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
  if (!listed.ok) throw new Error(await driveMessage(listed));
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
  if (!saved.ok) throw new Error(await driveMessage(saved));
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
