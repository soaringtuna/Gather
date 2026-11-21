import { classCsvName, courseToCsv, stateFromCsv } from "./csv.js?v=9";
import { beginDriveFolder, beginGoogleSignIn, canListDrive, createDriveFolder, listFolders, storedGoogleToken, takeGoogleResult, takePickedFolder, uploadToFolder } from "./drive.js?v=14";
import { expectationsForCode, findOntarioCourse, searchOntarioCourses } from "./ontario.js?v=18";
import { emptyState, loadState, normalizeCourse, normalizeState, saveState } from "./store.js?v=6";
import {
  KINDS,
  LEVELS,
  buttonLabel,
  formatDate,
  initials,
  kindById,
  levelById,
  levelFromPercent,
  parsePercent,
  parseStudentLine,
  studentName,
  studentSortKey,
  summarizeStudent,
  todayISO,
  uid,
} from "./model.js?v=3";

const appEl = document.querySelector("#app");
const toastEl = document.querySelector("#toast");
const modalEl = document.querySelector("#modal");
const importEl = document.querySelector("#import-file");

let db = emptyState();
let ui = {
  date: todayISO(),
  focus: {},
  classDraft: {},
  stick: { kind: "observation", expectationId: null },
  capture: null,
  search: "",
  codeQuery: "",
  draftCode: "",
  studentLineIds: {},
  studentDraft: {},
  studentView: "tiles",
};
let toastTimer = 0;
let drag = null;
let ignoreClick = false;
let loadCourseCode = "";
let loadingExpectations = false;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function catalogueCode(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text || text === "CHOOSE A COURSE") return "";
  if (findOntarioCourse(text)) return text;
  const lead = text.split(/\s|—|–|-/)[0];
  return lead && findOntarioCourse(lead) ? lead : "";
}

function codeFromCourseSelect() {
  const select = document.getElementById("course-code");
  if (!select) return "";
  const option = select.selectedOptions?.[0];
  return catalogueCode(select.value) || catalogueCode(option?.value) || catalogueCode(option?.textContent);
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.dataset.show = "false";
  }, 2200);
}

function confirmAction(message, confirmLabel = "Delete") {
  modalEl.innerHTML = `<form method="dialog"><p>${esc(message)}</p><menu>
    <button class="ghost" value="cancel" type="submit">Cancel</button>
    <button class="${/delete|erase|remove/i.test(confirmLabel) ? "danger" : "primary"}" value="ok" type="submit">${esc(confirmLabel)}</button>
  </menu></form>`;
  modalEl.showModal();
  return new Promise((resolve) => {
    modalEl.addEventListener("close", () => resolve(modalEl.returnValue === "ok"), { once: true });
  });
}

function persist() {
  saveState(db);
  scheduleDriveSync();
}

let driveSyncTimer = 0;
let driveSyncQueued = false;

function lastSyncText() {
  const stored = localStorage.getItem("class-record-google-synced-at");
  const time = stored ? new Date(stored) : null;
  if (!time || Number.isNaN(time.getTime())) return "Autosaved: Not Yet";
  const formatted = time.toLocaleString("en-CA", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Autosaved: ${formatted}`;
}

function noteDriveSync() {
  localStorage.setItem("class-record-google-synced-at", new Date().toISOString());
  const line = document.getElementById("last-sync");
  if (line) line.textContent = lastSyncText();
}

function scheduleDriveSync() {
  clearTimeout(driveSyncTimer);
  driveSyncTimer = setTimeout(() => {
    autoDriveSync();
  }, 700);
}

async function autoDriveSync({ prompt = false } = {}) {
  if (driveBackup.running) {
    driveSyncQueued = true;
    return;
  }
  if (!googleAccountReady()) {
    if (prompt) {
      warnIfGoogleMissing();
      scrollToGoogleSetup();
    }
    return;
  }
  const folder = storedFolder();
  if (!folder) {
    if (prompt) {
      showToast("Choose a Google Drive folder below.");
      scrollToGoogleSetup();
    }
    return;
  }
  const saved = storedGoogleToken();
  if (!saved?.token || !canListDrive(saved.scope)) {
    if (prompt) showToast("Sign in to sync.");
    return;
  }
  driveBackup.running = true;
  try {
    await saveClassesToFolder(saved.token, folder.id);
    noteDriveSync();
  } catch (error) {
    showToast(error.message || "The backup could not be saved.");
  } finally {
    driveBackup.running = false;
    if (driveSyncQueued) {
      driveSyncQueued = false;
      scheduleDriveSync();
    } else {
      driveSyncQueued = false;
    }
  }
}

function googleAccountReady() {
  return Boolean(googleEmail(sessionStorage.getItem("class-record-google-account")));
}

function alertAction(message) {
  if (modalEl.open) return;
  modalEl.classList.remove("drive-folder", "photo-view");
  modalEl.innerHTML = `<form method="dialog"><p>${esc(message)}</p><menu><button class="primary" value="ok" type="submit">OK</button></menu></form>`;
  modalEl.showModal();
}

function warnIfGoogleMissing() {
  if (googleAccountReady()) return;
  alertAction("You are not signed into Google Drive. All data is only temporarily saved in the App. Before you exit Backup Class to CSV (Setup). Classes can be re-added using the Import Class from CSV File.");
}

function scrollToGoogleSetup() {
  document.getElementById("google-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function expectationDescription(detail) {
  return String(detail || "").replace(/^\s*The Ontario Curriculum\b[^.]*\.\s*/i, "").trim();
}

function photoSrc(value) {
  return String(value || "").startsWith("data:image/") ? String(value) : "";
}

function readPhotoFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("image"));
      image.onload = () => {
        const max = 960;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function courseById(id) {
  return db.courses.find((course) => course.id === id) || null;
}

function studentById(course, id) {
  return course?.students.find((student) => student.id === id) || null;
}

function sortedStudents(course) {
  return [...course.students].sort((a, b) => studentSortKey(a).localeCompare(studentSortKey(b)));
}

function seatedStudents(course) {
  return [...course.students].sort((a, b) => a.seat - b.seat || studentSortKey(a).localeCompare(studentSortKey(b)));
}

function curriculumFor(course) {
  return expectationsForCode(course?.code);
}

function loadedExpectations(course) {
  if (!course) return [];
  if (course.expectationsManaged) return course.expectations;
  const items = curriculumFor(course).items;
  const officialIds = new Set(items.map((item) => item.id));
  const officialLabels = new Set(items.map((item) => item.label.toLowerCase()));
  const custom = course.expectations.filter((item) => !officialIds.has(item.id) && !officialLabels.has(item.label.toLowerCase()));
  return [...items, ...custom];
}

function knownExpectation(course, id) {
  if (!id || !course) return null;
  return loadedExpectations(course).find((item) => item.id === id) || null;
}

function expectationMenu(course, selectedId) {
  const curriculum = curriculumFor(course);
  const items = loadedExpectations(course);
  const options = (list) => list.map((item) => `<option value="${esc(item.id)}" ${item.id === selectedId ? "selected" : ""}>${esc(item.label)}</option>`).join("");
  const grouped = new Map();
  for (const item of items) {
    const name = item.group || "Added for this class";
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(item);
  }
  const html = [...grouped.entries()].map(([name, list]) => `<optgroup label="${esc(name)}">${options(list)}</optgroup>`).join("");
  const learningSkills = items.some((item) => String(item.id).startsWith("ls-"));
  const others = items.some((item) => !String(item.id).startsWith("ls-"));
  const growing = "Growing Success: Assessment, Evaluation, and Reporting in Ontario Schools, 2010";
  const official = course.curriculumCitation || curriculum.citation;
  const citation = learningSkills && others && official ? `${official}. ${growing}` : learningSkills ? growing : official;
  return { citation, html };
}

function chooseListMode(heading, detail) {
  modalEl.innerHTML = `<form method="dialog"><h2>${esc(heading)}</h2><p>${esc(detail)}</p><menu class="stack-menu">
    <button class="primary" value="replace" type="submit">Replace Current Expectations</button>
    <button class="primary" value="add" type="submit">Add To Existing List</button>
    <button class="ghost" value="cancel" type="submit">Cancel</button>
  </menu></form>`;
  modalEl.showModal();
  return new Promise((resolve) => {
    let choice = "";
    modalEl.querySelectorAll("button[value]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.value === "replace" || button.value === "add" || button.value === "cancel") choice = button.value;
      });
    });
    modalEl.addEventListener("close", () => {
      const value = choice || modalEl.returnValue;
      resolve(value === "replace" || value === "add" ? value : null);
    }, { once: true });
  });
}

function chooseExpectationDepth(hasSpecific) {
  const note = hasSpecific ? "" : `<p>Specific expectations are not available for this course code yet.</p>`;
  modalEl.innerHTML = `<form method="dialog"><h2>Load Expectations</h2><p>Load just the overall expectations, or also include the specific expectations?</p>${note}<menu class="stack-menu">
    <button class="primary" value="overall" type="submit">Overall Expectations</button>
    <button class="primary" value="specific" type="submit" ${hasSpecific ? "" : "disabled"}>Overall And Specific Expectations</button>
    <button class="ghost" value="cancel" type="submit">Cancel</button>
  </menu></form>`;
  modalEl.showModal();
  return new Promise((resolve) => {
    modalEl.addEventListener("close", () => {
      const value = modalEl.returnValue;
      resolve(value === "overall" || value === "specific" ? value : null);
    }, { once: true });
  });
}

const LEARNING_SKILLS = [
  ["responsibility", "Responsibility", [
    ["commitments", "Meets commitments in class"],
    ["timelines", "Submits work on time"],
    ["behaviour", "Manages own behaviour"],
  ]],
  ["organization", "Organization", [
    ["plan", "Follows a plan to finish tasks"],
    ["time", "Sets priorities and manages time"],
    ["resources", "Finds and uses resources for a task"],
  ]],
  ["independent-work", "Independent Work", [
    ["monitor", "Checks and revises a plan to meet a goal"],
    ["class-time", "Uses class time for the task"],
    ["instructions", "Follows instructions with little supervision"],
  ]],
  ["collaboration", "Collaboration", [
    ["share-work", "Takes a fair share of the group work"],
    ["ideas", "Responds positively to other people's ideas"],
    ["relationships", "Builds respectful relationships with peers"],
    ["conflict", "Works through conflict toward a group goal"],
    ["expertise", "Shares resources and expertise to solve a problem"],
  ]],
  ["initiative", "Initiative", [
    ["ideas", "Acts on new ideas for learning"],
    ["risks", "Tries a new approach"],
    ["curiosity", "Shows interest in learning"],
    ["attitude", "Starts a new task with a positive attitude"],
    ["advocacy", "Speaks up appropriately for self and others"],
  ]],
  ["self-regulation", "Self-Regulation", [
    ["goals", "Sets a goal and checks progress"],
    ["help", "Asks for help when needed"],
    ["reflection", "Reflects on strengths and needs"],
    ["strategies", "Chooses a strategy to meet a goal"],
    ["perseverance", "Keeps trying when the work is hard"],
  ]],
];

function learningSkillExpectations() {
  return LEARNING_SKILLS.flatMap(([skillId, skill, behaviours]) => behaviours.map(([key, behaviour]) => ({
    id: `ls-${skillId}-${key}`,
    label: `${skill}: ${behaviour}`,
    detail: behaviour,
    group: skill,
  })));
}

function chooseLearningSkillMode() {
  return chooseListMode("Load Learning Skills", "Replace the current expectations, or add the learning skills to the existing list?");
}

function expectationRecord(item) {
  return { id: item.id, label: item.label, detail: item.detail || item.label, group: item.group || "" };
}

function expectationsFromLines(course, text) {
  const lines = String(text || "").split("\n").map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean);
  const pool = loadedExpectations(course).map(expectationRecord);
  const used = new Set();
  return lines.map((label) => {
    const found = pool.find((item) => !used.has(item.id) && item.label.toLowerCase() === label.toLowerCase());
    if (!found) return { id: uid("exp"), label, detail: label, group: "" };
    used.add(found.id);
    return found;
  });
}

function visibleExpectations(course) {
  const field = document.getElementById("expectation-list");
  if (field) return expectationsFromLines(course, field.value);
  return loadedExpectations(course).map(expectationRecord);
}

function appendExpectations(current, incoming) {
  const next = current.map((item) => ({ ...item }));
  const ids = new Set(next.map((item) => item.id));
  const labels = new Set(next.map((item) => item.label.toLowerCase()));
  for (const item of incoming) {
    const record = expectationRecord(item);
    if (ids.has(record.id) || labels.has(record.label.toLowerCase())) continue;
    ids.add(record.id);
    labels.add(record.label.toLowerCase());
    next.push(record);
  }
  return next;
}

function finishExpectationEdit(course) {
  course.expectationsManaged = true;
  if (ui.focus[course.id] !== "custom" && !course.expectations.some((item) => item.id === ui.focus[course.id])) ui.focus[course.id] = "";
  if (ui.stick.expectationId && !course.expectations.some((item) => item.id === ui.stick.expectationId)) ui.stick.expectationId = null;
}

function applyLearningSkills(course, mode, existing) {
  const skills = learningSkillExpectations();
  const current = Array.isArray(existing) ? existing : visibleExpectations(course);
  course.expectations = mode === "add" ? appendExpectations(current, skills) : skills.map(expectationRecord);
  finishExpectationEdit(course);
}

function applyCatalogueExpectations(course, options = {}) {
  const curriculum = options.curriculum || expectationsForCode(course.code, options);
  if (!curriculum.items.length) return false;
  const incoming = curriculum.items.map(expectationRecord);
  const current = Array.isArray(options.existing) ? options.existing : visibleExpectations(course);
  course.expectations = options.mode === "add" ? appendExpectations(current, incoming) : incoming;
  if (curriculum.citation) {
    const citation = curriculum.citation.replace(/\s+/g, " ").trim();
    if (options.mode === "add" && course.curriculumCitation && !course.curriculumCitation.includes(citation)) course.curriculumCitation = `${course.curriculumCitation}. ${citation}`;
    else if (options.mode !== "add" || !course.curriculumCitation) course.curriculumCitation = citation;
  }
  finishExpectationEdit(course);
  return true;
}

function curriculumLines(payload, includeSpecific) {
  return (payload.items || []).filter((item) => includeSpecific || !item.specific).map((item) => ({
    id: item.id,
    label: item.label,
    detail: item.detail || item.label,
    group: includeSpecific ? (item.group || item.strand || "") : (item.strand || ""),
  }));
}

function showCurriculumProgress() {
  let closedByApp = false;
  let cancelled = false;
  modalEl.innerHTML = `<form method="dialog"><h2>Load Expectations</h2><p id="curriculum-progress-label">Finding the curriculum document</p><progress id="curriculum-progress" class="curriculum-progress" max="100" value="8"></progress><menu class="stack-menu"><button class="ghost" value="cancel" type="submit">Cancel</button></menu></form>`;
  const label = document.getElementById("curriculum-progress-label");
  const bar = document.getElementById("curriculum-progress");
  let value = 8;
  const timer = setInterval(() => {
    if (value < 90) value += value < 36 ? 5 : 1;
    if (bar) bar.value = value;
    if (label && value > 30) label.textContent = "Reading the curriculum document";
  }, 250);
  modalEl.showModal();
  const cancelButton = modalEl.querySelector("button[value='cancel']");
  cancelButton?.addEventListener("click", () => { cancelled = true; });
  return {
    get cancelled() { return cancelled; },
    finish() {
      closedByApp = true;
      clearInterval(timer);
      if (bar) bar.value = 100;
      if (modalEl.open) modalEl.close();
    },
    whenClosed: new Promise((resolve) => {
      modalEl.addEventListener("close", () => {
        clearInterval(timer);
        if (!closedByApp) cancelled = true;
        resolve(cancelled);
      }, { once: true });
    }),
  };
}

async function fetchCurriculumDocument(code, signal) {
  let response;
  try {
    response = await fetch(`/api/curriculum?code=${encodeURIComponent(code)}`, { signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const failure = new Error("The curriculum document could not be reached.");
    failure.offline = true;
    throw failure;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.items?.length) {
    const failure = new Error(payload?.error || `No expectations were found in the curriculum document for ${code}.`);
    failure.offline = !response.ok && response.status >= 500;
    throw failure;
  }
  return payload;
}

function parseRoute() {
  const parts = (location.hash || "#/").replace(/^#/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "new") return { name: "new" };
  if (parts[0] === "c" && parts[1]) {
    const courseId = parts[1];
    const page = parts[2] || "class";
    if (page === "capture" && parts[3]) return { name: "capture", courseId, studentId: parts[3], entryId: parts[4] || null };
    if (page === "s" && parts[3]) return { name: "student", courseId, studentId: parts[3] };
    if (["class", "roster", "setup"].includes(page)) return { name: page, courseId };
    return { name: "class", courseId };
  }
  return { name: "home" };
}

function hrefFor(courseId, page = "class") {
  return `#/c/${encodeURIComponent(courseId)}/${page}`;
}

let keptTab = "class";

function tabName(route = parseRoute()) {
  if (route.name === "student") return "roster";
  if (route.name === "capture") return "class";
  if (["class", "roster", "setup"].includes(route.name)) return route.name;
  return "";
}

function studentHref(courseId, studentId) {
  return `#/c/${encodeURIComponent(courseId)}/s/${encodeURIComponent(studentId)}`;
}

function captureHref(courseId, studentId, entryId) {
  const base = `#/c/${encodeURIComponent(courseId)}/capture/${encodeURIComponent(studentId)}`;
  return entryId ? `${base}/${encodeURIComponent(entryId)}` : base;
}

function sessionOn(course, date) {
  return course.sessions.find((session) => session.date === date) || null;
}

function ensureSession(course, date) {
  let session = sessionOn(course, date);
  if (session) return session;
  session = { id: uid("ses"), date, topic: "" };
  course.sessions.push(session);
  course.sessions.sort((a, b) => a.date.localeCompare(b.date));
  return session;
}

function expectationReady(course, capture) {
  if (!capture) return false;
  if (capture.expectationId === "custom") return capture.customText.trim().length > 0;
  return Boolean(knownExpectation(course, capture.expectationId));
}

function classDraft(courseId) {
  if (!ui.classDraft[courseId]) ui.classDraft[courseId] = { text: "", saveCustom: true };
  return ui.classDraft[courseId];
}

function customExpectationOption(selected) {
  return `<option value="custom" ${selected ? "selected" : ""}>Create Custom Expectation</option>`;
}

function customExpectationFields({ text, saveCustom, textId, checkId }) {
  return `<label class="field" style="margin-top:10px">Custom Expectation<textarea id="${textId}" maxlength="400" placeholder="Describe Your Expectation Here.">${esc(text)}</textarea></label>
    <label class="field check"><span><input id="${checkId}" type="checkbox" ${saveCustom ? "checked" : ""}/> Add This Custom Expectation To The List.</span></label>`;
}

function render() {
  const route = parseRoute();
  const tab = tabName(route);
  if (tab) keptTab = tab;
  if (route.courseId && db.lastCourseId !== route.courseId) {
    db.lastCourseId = route.courseId;
    persist();
  }
  const course = courseById(route.courseId);
  if (route.name === "capture" && course) ensureCapture(course, route);
  else ui.capture = null;

  const active = document.activeElement;
  const activeId = active?.id || "";
  const selectionStart = active?.selectionStart;
  const selectionEnd = active?.selectionEnd;
  try {
    paint(route, course);
  } catch (error) {
    console.error(error);
    appEl.innerHTML = `${brandBanner()}<main class="main"><h1>Something Went Wrong</h1><p>${esc(error.message)}</p></main>`;
  }
  if (activeId && active?.tagName !== "SELECT") {
    const next = document.getElementById(activeId);
    if (next) {
      next.focus();
      if (typeof selectionStart === "number" && next.setSelectionRange) {
        try {
          next.setSelectionRange(selectionStart, selectionEnd);
        } catch {
          /* range and number inputs */
        }
      }
    }
  }
  document.title = course ? `${course.code || course.name} · Class Record` : "Class Record";
}

function paint(route, course) {
  if (route.courseId && !course) {
    appEl.innerHTML = shell(route, null, `<section class="card"><h1>That Course Is Not On This Device</h1><p><a href="#/">Back to courses</a></p></section>`);
    return;
  }
  let body = "";
  if (route.name === "home") body = renderHome();
  else if (route.name === "new") body = renderNewCourse();
  else if (route.name === "class") body = renderClass(course);
  else if (route.name === "roster") body = renderRoster(course);
  else if (route.name === "setup") body = renderSetup(course);
  else if (route.name === "capture") {
    const student = studentById(course, route.studentId);
    body = student && ui.capture
      ? renderCapture(course, student)
      : `<section class="card"><h1>That Entry Is Not Available</h1><p><a href="${hrefFor(course.id)}">Back to class</a></p></section>`;
  } else if (route.name === "student") {
    const student = studentById(course, route.studentId);
    body = student
      ? renderStudent(course, student)
      : `<section class="card"><h1>That Student Is Not In This Course</h1><p><a href="${hrefFor(course.id, "roster")}">Back to the roster</a></p></section>`;
  }
  appEl.innerHTML = shell(route, course, body);
  requestAnimationFrame(fitSeatTiles);
}

function fitSeatTiles() {
  document.querySelectorAll(".floor .tile").forEach((tile) => {
    const link = tile.querySelector("a");
    const initials = tile.querySelector("strong");
    if (!link || !initials) return;
    const width = tile.clientWidth;
    if (!width) return;
    let low = 12;
    let high = width * 0.46;
    let best = low;
    for (let step = 0; step < 12; step += 1) {
      const size = (low + high) / 2;
      initials.style.fontSize = size + "px";
      const fits = link.scrollHeight <= link.clientHeight + 1 && link.scrollWidth <= link.clientWidth + 1;
      if (fits) {
        best = size;
        low = size;
      } else high = size;
    }
    initials.style.fontSize = best + "px";
  });
}

function brandBanner() {
  return `<div class="brand-banner"><img src="img/gathered-logo.jpg?v=5" alt="GATHERED. Getting it together." /></div>`;
}

function classSwitcher(course) {
  const options = db.courses
    .map((item) => `<option value="${esc(item.id)}" ${course && item.id === course.id ? "selected" : ""}>${esc(item.code || "Class")} — ${esc(item.name)}${item.sample ? " (sample)" : ""}</option>`)
    .join("");
  if (!db.courses.length) return "";
  return `<div class="class-pick"><select id="class-switch" aria-label="Class">${options}</select></div>`;
}

function shell(route, course, body) {
  const capturing = route.name === "capture";
  const tabs = course && !capturing
    ? `<nav class="tabs" aria-label="Course">
        ${tab(course, "class", "NEW ENTRY", route)}
        <div class="tab-row">
          ${tab(course, "roster", "EVIDENCE", route)}
          ${tab(course, "setup", "SETUP", route)}
        </div>
      </nav>`
    : "";
  const heading = course ? "" : route.name === "new" ? "New Class" : "Classes";
  const courseLede = course
    ? `${esc(course.semesterLabel || "Semester Not Set")} · Grade ${course.grade}${course.period ? ` · Period ${esc(course.period)}` : ""}`
    : "";
  const lede = course
    ? ""
    : route.name === "new"
      ? "Search the Ontario course code (or first letters), then choose the course from the drop down. Expectations will come from that chosen Curriculum."
      : db.courses.length
        ? "Choose the active class above. Several classes can stay on this device."
        : "";
  const title = heading ? `<div class="course-heading"><h1>${heading}</h1>${lede ? `<p class="lede">${lede}</p>` : ""}</div>` : "";
  const switcher = classSwitcher(course);
  const header = switcher || courseLede
    ? `<header class="appbar"><div class="class-panel">${switcher}${courseLede ? `<p class="lede course-lede">${courseLede}</p>` : ""}</div></header>`
    : "";
  return `<div class="shell ${capturing ? "is-capture" : ""}">
    ${brandBanner()}
    ${header}
    <div class="main">
      ${capturing ? "" : `<div class="topbar">${title}${tabs}</div>`}
      <div id="main" tabindex="-1">${body}</div>
    </div>
  </div>`;
}

function tab(course, page, label, route) {
  const on = route.name === page || (page === "roster" && route.name === "student") || (page === "class" && route.name === "capture");
  const mark = page === "class" ? ` class="tab-entry"` : "";
  return `<a href="${hrefFor(course.id, page)}"${mark} ${on ? `aria-current="page"` : ""}>${label}</a>`;
}

function renderHome() {
  if (!db.courses.length) {
    return `<section class="card"><p>Start by adding a class.</p><p><a class="primary" href="#/new" style="display:inline-block;text-decoration:none">Create A Class</a></p></section>`;
  }
  return `<section class="card"><h2>Choose A Class</h2><p>Use the active class list at the top. Each class keeps its own students, seating plan, and entries.</p></section>`;
}

function courseCodeFields(selected) {
  const current = findOntarioCourse(selected);
  const matches = searchOntarioCourses(ui.codeQuery);
  const options = [];
  if (selected && !matches.some((item) => item.code === selected)) {
    options.push(current || { code: selected, title: "Saved code", gradeLabel: "" });
  }
  options.push(...matches);
  const list = options
    .map((item) => `<option value="${esc(item.code)}" ${item.code === selected ? "selected" : ""}>${esc(item.code)} — ${esc(item.title)}</option>`)
    .join("");
  return `<label class="field span-2">Search For Courses<input id="code-search" type="search" value="${esc(ui.codeQuery)}" placeholder="Enter Course Code or Keyword" autocomplete="off" /></label>
    <label class="field span-2">Select A Course Curriculum<select id="course-code" name="code"><option value="">Choose A Course</option>${list}</select></label>`;
}

function periodValue(value) {
  const period = String(value || "").trim();
  return ["1", "2", "3", "4", "5"].includes(period) ? period : "";
}

function periodField(value) {
  const current = periodValue(value);
  const options = [
    ["", "Not Set"],
    ["1", "Period 1"],
    ["2", "Period 2"],
    ["3", "Period 3"],
    ["4", "Period 4"],
    ["5", "Period 5"],
  ];
  return `<label class="field">Period<select name="period">${options.map(([period, label]) => `<option value="${period}" ${current === period ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
}

function gradeOptions(selected) {
  const grade = [9, 10, 11, 12].includes(Number(selected)) ? Number(selected) : "";
  return [9, 10, 11, 12].map((item) => `<option ${item === grade ? "selected" : ""}>${item}</option>`).join("");
}

function renderNewCourse() {
  const selected = ui.draftCode;
  const catalogue = findOntarioCourse(selected);
  return `<form class="card form-grid" data-action="create-course">
    ${courseCodeFields(selected)}
    <label class="field">Course Title<input name="name" type="text" required value="${esc(catalogue?.title || "")}" placeholder="English" /></label>
    <label class="field">Grade<select name="grade">${gradeOptions(catalogue?.grade ?? 10)}</select></label>
    <label class="field">Semester<input name="semester" type="text" value="Semester 1, 2026–27" /></label>
    ${periodField("")}
    <label class="field span-2">Students, One Per Line<textarea name="students" placeholder="Add your Students (or do this later...)"></textarea></label>
    <div class="span-2"><button class="primary" type="submit">Create Class</button></div>
  </form>`;
}

function isoFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftISO(iso, days) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return isoFromDate(date);
}

function mondayOnOrBefore(iso) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = date.getDay();
  date.setDate(date.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  return isoFromDate(date);
}

function weekStartFor(course) {
  return /^\d{4}-\d{2}-\d{2}$/.test(course?.weekStart || "") ? course.weekStart : mondayOnOrBefore(todayISO());
}

function weeklyEntryCount(course, studentId, start) {
  const end = shiftISO(start, 6);
  return course.entries.filter((entry) => entry.studentId === studentId && entry.date >= start && entry.date <= end).length;
}

function seatLayout(course) {
  const columns = course.seatColumns;
  const students = seatedStudents(course);
  const needed = Math.max(1, Math.ceil(students.length / columns) || 1);
  const chosen = Number(course.seatRows);
  const rows = Math.max(needed, chosen >= 1 && chosen <= 8 ? chosen : needed);
  const capacity = columns * rows;
  const bySeat = new Map();
  const loose = [];
  for (const student of students) {
    const seat = student.seat;
    if (Number.isInteger(seat) && seat >= 0 && seat < capacity && !bySeat.has(seat)) bySeat.set(seat, student);
    else loose.push(student);
  }
  for (const student of loose) {
    for (let seat = 0; seat < capacity; seat += 1) {
      if (!bySeat.has(seat)) {
        bySeat.set(seat, student);
        break;
      }
    }
  }
  const cells = [];
  for (let seat = 0; seat < capacity; seat += 1) cells.push(bySeat.get(seat) || null);
  return { columns, rows, cells };
}

function renderClass(course) {
  const focusId = ui.focus[course.id] || "";
  const session = sessionOn(course, ui.date);
  const layout = seatLayout(course);
  const target = Number(course.weeklyTarget) || 0;
  const weekStart = weekStartFor(course);
  const tiles = layout.cells
    .map((student) => {
      if (!student) return `<div class="tile is-empty" aria-hidden="true"></div>`;
      const weekly = weeklyEntryCount(course, student.id, weekStart);
      const total = course.entries.filter((entry) => entry.studentId === student.id).length;
      const tone = target ? (weekly >= target ? "is-met" : "is-short") : "";
      const progress = target ? `, ${weekly} of ${target} toward the weekly goal` : "";
      return `<div class="tile ${tone}" data-student="${esc(student.id)}"><span class="tile-count week" aria-hidden="true">${weekly}</span><span class="tile-count total" aria-hidden="true">${total}</span><a href="${captureHref(course.id, student.id)}" aria-label="${esc(studentName(student))}, ${weekly} this week, ${total} total${esc(progress)}"><strong>${esc(initials(student))}</strong></a></div>`;
    })
    .join("");
  const expectationOptions = expectationMenu(course, focusId);
  const draft = classDraft(course.id);
  const listView = ui.studentView === "list";
  const studentOptions = seatedStudents(course)
    .map((student) => `<option value="${esc(student.id)}">${esc(studentName(student))}</option>`)
    .join("");
  const tileBlock = course.students.length
    ? `<div class="floor-slot"><div class="floor-fit" style="--cols:${layout.columns};--rows:${layout.rows}"><div class="floor">${tiles}</div></div></div><p class="sub seat-note">Drag tiles to rearrange them.</p>`
    : `<p>Add students in Setup, then record from here.</p>`;
  const seatControls = `<div class="row seats-row">
        <label class="field">Cols<input id="seat-columns" type="number" min="2" max="8" value="${layout.columns}" /></label>
        <label class="field">Rows<input id="seat-rows" type="number" min="1" max="8" value="${layout.rows}" /></label>
      </div>`;
  return `<div class="stack">
    ${sampleBanner(course)}
    <section class="panel seat-plan">
      <div class="panel-head">
        <h2>STUDENT LIST</h2>
        <button type="button" class="ghost" data-action="toggle-student-view">${listView ? "TILE VIEW" : "LIST VIEW"}</button>
      </div>
      ${listView
        ? (course.students.length
          ? `<label class="field">Student<select id="student-list-pick"><option value="">Choose A Student</option>${studentOptions}</select></label>`
          : `<p>Add students in Setup, then record from here.</p>`)
        : `${tileBlock}${seatControls}`}
    </section>
    <section class="panel entry-panel">
      <h2>NEW ENTRY DETAILS</h2>
      <div class="class-focus">
        <label class="field"><select id="focus-expectation" aria-label="Curriculum Expectation"><option value="">Choose An Expectation</option>${expectationOptions.html}${customExpectationOption(focusId === "custom")}</select></label>
        ${focusId === "custom" ? customExpectationFields({ text: draft.text, saveCustom: draft.saveCustom, textId: "class-custom-expectation", checkId: "class-save-custom" }) : ""}
        <label class="field"><input id="class-date" type="date" aria-label="Class Date" value="${esc(ui.date)}" /></label>
        <label class="field"><input id="class-topic" type="text" placeholder="Current Class Topic (Optional)" aria-label="Topic" value="${esc(session?.topic || "")}" /></label>
        <div class="doc-note">
          <p class="doc-title">Active Curriculum Document</p>
          <p class="sub">${expectationOptions.citation ? `${esc(expectationOptions.citation)}.` : "This course code does not have a curriculum list loaded yet. Add expectations in Setup."}</p>
        </div>
      </div>
    </section>
    <section class="panel week-plan">
      <h2>WEEKLY DATA GOAL</h2>
      <div class="row week-row">
        <label class="field">Week Of<input id="week-start" type="date" value="${esc(weekStart)}" /></label>
        <label class="field week-goal">Weekly Goal<input id="weekly-target" type="range" min="0" max="10" step="1" value="${target}" /><output id="weekly-target-value" for="weekly-target">${target}</output></label>
      </div>
      <p class="week-note">Week Of is the first day of the week being counted, and that week includes the next six days. Choose how many entries each student should have in that week. 0 leaves the tiles light grey. A chosen goal turns a tile yellow until the student reaches it, then green.</p>
    </section>
  </div>`;
}

function sampleBanner(course) {
  if (!course.sample) return "";
  return `<aside class="banner"><p><strong>Sample class.</strong> The students are fictional. Remove it before you record a real class on this device.</p><button type="button" class="ghost noprint" data-action="delete-course">Remove Sample</button></aside>`;
}

function entryCard(course, entry) {
  const student = studentById(course, entry.studentId);
  const level = levelById(entry.level);
  return `<article class="entry">
    <header>
      <strong>${esc(student ? studentName(student) : "Student")} · ${esc(kindById(entry.kind).label)}</strong>
      <span class="mini lv-${esc(entry.level)}">${esc(level ? level.name : "Level")} · ${esc(entry.percent)}%</span>
    </header>
    <div>${esc(entry.expectationLabel)}</div>
    <div class="sub">${esc(formatDate(entry.date))}</div>
    ${entry.note ? `<p class="note">${esc(entry.note)}</p>` : ""}
    ${photoSrc(entry.photo) ? `<img class="entry-photo" alt="Photo For This Entry" src="${entry.photo}" />` : ""}
    <div class="row noprint">
      <a class="ghost" style="text-decoration:none" href="${captureHref(course.id, entry.studentId, entry.id)}">Edit</a>
      <button type="button" class="text-button" data-action="delete-entry" data-entry="${esc(entry.id)}">Delete</button>
    </div>
  </article>`;
}

function ensureCapture(course, route) {
  const key = `${route.studentId}:${route.entryId || "new"}`;
  if (ui.capture?.key === key) return;
  if (route.entryId) {
    const entry = course.entries.find((item) => item.id === route.entryId);
    if (!entry) {
      ui.capture = null;
      return;
    }
    const stillThere = Boolean(knownExpectation(course, entry.expectationId));
    ui.capture = {
      key,
      date: entry.date,
      studentId: entry.studentId,
      entryId: entry.id,
      kind: entry.kind,
      expectationId: stillThere ? entry.expectationId : "custom",
      customText: stillThere ? "" : entry.expectationLabel,
      saveCustom: false,
      level: entry.level,
      percent: entry.percent,
      touched: true,
      note: entry.note || "",
      photo: photoSrc(entry.photo),
      showNote: Boolean(entry.note),
    };
    return;
  }
  const focusId = ui.focus[course.id] || "";
  const draft = classDraft(course.id);
  const useCustom = focusId === "custom";
  const preferred = focusId || ui.stick.expectationId;
  ui.capture = {
    key,
    date: ui.date,
    studentId: route.studentId,
    entryId: null,
    kind: ui.stick.kind || "observation",
    expectationId: useCustom ? "custom" : knownExpectation(course, preferred) ? preferred : null,
    customText: useCustom ? draft.text : "",
    saveCustom: useCustom ? draft.saveCustom : true,
    level: null,
    percent: 75,
    touched: false,
    note: "",
    photo: "",
    showNote: false,
  };
}

function renderCapture(course, student) {
  const capture = ui.capture;
  const selected = knownExpectation(course, capture.expectationId);
  const expectationOk = expectationReady(course, capture);
  const ready = capture.touched && expectationOk;
  const saveLabel = ready ? "Save Entry" : expectationOk ? "Choose Level To Save Entry" : "No Expectation Selected";
  const expectationOptions = expectationMenu(course, capture.expectationId);
  const levelButtons = LEVELS.filter((item) => item.id !== "0")
    .map((item) => `<button type="button" class="level-btn" data-action="pick-level" data-level="${item.id}" aria-pressed="${capture.touched && capture.level === item.id}"><b>${item.short}</b><small>${item.band}</small></button>`)
    .join("");
  return `<form class="capture" data-action="save-form">
    <a class="back" href="${hrefFor(course.id)}">← ${esc(formatDate(capture.date || ui.date))}</a>
    <h1>${esc(studentName(student))}</h1>
    <section>
      <div class="kind-row">
        ${["observation", "conversation"].map((id) => KINDS.find((kind) => kind.id === id)).map((kind) => `<button type="button" class="kind-btn ${kind.id === "observation" ? "observation" : ""}" data-action="pick-kind" data-kind="${kind.id}" aria-pressed="${capture.kind === kind.id}">${kind.label}</button>`).join("")}
      </div>
    </section>
    <section>
      <label class="field">
        <select id="expectation-select" aria-label="Expectation">
          <option value="">Choose An Expectation</option>
          ${expectationOptions.html}
          ${customExpectationOption(capture.expectationId === "custom")}
        </select>
      </label>
      ${capture.expectationId === "custom"
        ? customExpectationFields({ text: capture.customText, saveCustom: capture.saveCustom, textId: "custom-expectation", checkId: "save-custom" })
        : selected
          ? `<p class="chosen">${esc(expectationDescription(selected.detail) || selected.label)}</p>`
          : ""}
      <div class="evidence-actions">
        <button type="button" class="primary" data-action="add-photo">Add Photo</button>
        <button type="button" class="primary" data-action="add-note">Add Note</button>
      </div>
      <input id="entry-photo" class="photo-input" type="file" accept="image/*" />
      ${photoSrc(capture.photo) ? `<img class="entry-photo" alt="Photo For This Entry" src="${capture.photo}" /><button type="button" class="text-button" data-action="remove-photo">Remove Photo</button>` : ""}
      ${capture.showNote ? `<label class="field" style="margin-top:10px"><input id="entry-note" type="text" maxlength="400" aria-label="Note" value="${esc(capture.note)}" /></label>` : ""}
    </section>
    <section class="dock ${capture.touched ? "is-set" : ""}">
      <div class="level-row">${levelButtons}</div>
      <button type="button" class="chip-btn below-btn" data-action="pick-level" data-level="0" aria-pressed="${capture.touched && capture.level === "0"}">Below Level 1 · Under 50%</button>
      <button id="save-entry" class="save-bar save" type="submit" ${ready ? "" : "disabled"}>${esc(saveLabel)}</button>
    </section>
  </form>`;
}

function reportKindColor(kind) {
  return kind === "conversation" ? "#0f7a4b" : "#1d4ed8";
}

function reportLegend() {
  return `<p class="report-legend"><i class="is-observation"></i> Observation <i class="is-conversation"></i> Conversation</p>`;
}

function reportChartSvg({ aria, yTitle, yTicks, points, connect }) {
  const width = 640;
  const height = 248;
  const left = 72;
  const right = 16;
  const top = 12;
  const bottom = 52;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const ticks = yTicks.map((tick) => {
    const y = top + (1 - tick.t) * plotH;
    return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${left + plotW}" y2="${y.toFixed(1)}" stroke="#e3e5ea" /><text x="${left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#3c434d">${esc(tick.label)}</text>`;
  }).join("");
  const coords = points.map((point, index) => ({
    ...point,
    x: points.length === 1 ? left + plotW / 2 : left + (index / (points.length - 1)) * plotW,
    y: top + (1 - point.t) * plotH,
  }));
  const line = connect && coords.length > 1
    ? `<polyline fill="none" stroke="#121417" stroke-width="1.5" points="${coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}" />`
    : "";
  const dots = coords.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5" fill="${reportKindColor(point.kind)}" stroke="#ffffff" stroke-width="1.5"><title>${esc(point.title)}</title></circle>`).join("");
  const dateIndexes = coords.length <= 4 ? coords.map((_, index) => index) : [0, Math.floor((coords.length - 1) / 2), coords.length - 1];
  const dates = dateIndexes.map((index) => `<text x="${coords[index].x.toFixed(1)}" y="${(top + plotH + 20).toFixed(1)}" text-anchor="middle" font-size="12" fill="#3c434d">${esc(coords[index].dateLabel)}</text>`).join("");
  const yLabel = `<text transform="translate(16 ${(top + plotH / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="12" font-weight="700" fill="#121417">${esc(yTitle)}</text>`;
  const xLabel = `<text x="${(left + plotW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="12" font-weight="700" fill="#121417">Date</text>`;
  const axis = `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="#121417" /><line x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}" stroke="#121417" />`;
  return `<svg class="report-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(aria)}">${yLabel}${ticks}${axis}${line}${dots}${dates}${xLabel}</svg>`;
}

function reportPerformance(entries) {
  const levelPoints = [...entries].reverse().filter((entry) => levelById(entry.level)).map((entry) => ({
    t: Number(entry.level) / 4,
    kind: entry.kind,
    dateLabel: shortMonthDay(entry.date),
    title: `${formatDate(entry.date)}, ${kindById(entry.kind).label}, ${levelById(entry.level).name}`,
  }));
  const levelChart = levelPoints.length
    ? reportChartSvg({
      aria: `Achievement level over time, oldest to newest. ${levelPoints.map((point) => point.title).join("; ")}`,
      yTitle: "Achievement Level",
      yTicks: [0, 1, 2, 3, 4].map((level) => ({ t: level / 4, label: String(level) })),
      points: levelPoints,
      connect: true,
    })
    : `<p>No levels recorded yet.</p>`;
  return `<h2>Levels Over Time</h2>
    <figure class="report-chart">${levelChart}${reportLegend()}<p>The line joins each recorded level, oldest on the left. Each point is one conversation or observation. The vertical axis is the achievement level, and 0 is below Level 1.</p></figure>`;
}

function classReportLine(course) {
  return [course.code, course.name, course.semesterLabel, course.grade ? `Grade ${course.grade}` : "", course.period ? `Period ${course.period}` : ""].filter(Boolean).join(" · ");
}

function studentReportPage(course, student) {
  const summary = summarizeStudent(course, student);
  const average = averageLevel(summary.entries);
  const bars = LEVELS.map((level) => `<span class="lv-${level.id}">${level.short} · ${summary.byLevel[level.id]}</span>`).join("");
  const notes = String(summary.mark?.comment || "").trim();
  const checkpoints = Array.isArray(summary.mark?.checkpoints) ? summary.mark.checkpoints : [];
  const entries = [...summary.entries].reverse();
  const entryRows = entries.length
    ? entries.map((entry) => {
      const level = levelById(entry.level);
      const note = [String(entry.note || "").trim(), photoSrc(entry.photo) ? "Photo attached." : ""].filter(Boolean).join(" ");
      return `<tr><td>${esc(formatDate(entry.date))}</td><td>${esc(kindById(entry.kind).label)}</td><td>${esc(entry.expectationLabel || "")}</td><td>${esc(level ? level.name : "")}</td><td>${Number.isFinite(Number(entry.percent)) ? `${esc(entry.percent)}%` : ""}</td><td>${esc(note)}</td></tr>`;
    }).join("")
    : `<tr><td colspan="6">No entries yet.</td></tr>`;
  const checkpointBlock = checkpoints.length
    ? `<h2>Checkpoints</h2><ul class="report-list">${checkpoints.map((item) => `<li><strong>${esc(item.name || "Checkpoint")}</strong>${item.date ? ` · ${esc(formatDate(item.date))}` : ""}${item.average != null && item.average !== "" ? ` · Average ${esc(Number(item.average).toFixed(1))}` : ""}${item.note ? ` · ${esc(item.note)}` : ""}</li>`).join("")}</ul>`
    : "";
  const countLabel = `${summary.entries.length} ${summary.entries.length === 1 ? "entry" : "entries"}`;
  return `<article class="report-page">
    <p class="report-brand">MARCBOOK</p>
    <h1>${esc(studentName(student))}</h1>
    <p class="report-meta">${esc(classReportLine(course))}</p>
    <h2>Levels</h2>
    <div class="tally">${bars}</div>
    <p>${average == null ? "No levels recorded yet." : `Average level ${esc(levelSummaryText(average))} from ${countLabel}.`} ${summary.counts.conversation} conversations and ${summary.counts.observation} observations.</p>
    ${reportPerformance(summary.entries)}
    ${notes ? `<h2>Notes</h2><p class="report-notes">${esc(notes)}</p>` : ""}
    <h2>Entries</h2>
    <table class="report-table"><thead><tr><th>Date</th><th>Kind</th><th>Expectation</th><th>Level</th><th>Percent</th><th>Note</th></tr></thead><tbody>${entryRows}</tbody></table>
    ${checkpointBlock}
  </article>`;
}

function reportFilePart(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
}

function reportFileName(course, students) {
  const date = todayISO();
  const code = reportFilePart(course.code) || "Class";
  if (students.length === 1) return `${reportFilePart(studentName(students[0])) || "Student"} ${code} ${date}`;
  const period = course.period ? `Period ${reportFilePart(course.period)}` : "Period not set";
  return `${code} ${period} ${date}`;
}

function reportStylesheetText() {
  for (const sheet of document.styleSheets) {
    if (!sheet.href || !sheet.href.includes("/css/styles.css")) continue;
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText).join("\n").replace(/<\/style/gi, "<\\/style");
    } catch (error) {
      return "";
    }
  }
  return "";
}

function exportReports(course, students) {
  if (!students.length) {
    showToast("There are no students to export.");
    return;
  }
  const name = reportFileName(course, students);
  const pages = students.map((student) => studentReportPage(course, student)).join("");
  let frame = document.getElementById("print-frame");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "print-frame";
    frame.title = "Report";
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:816px;height:1056px;border:0;";
    document.body.appendChild(frame);
  }
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!DOCTYPE html><html lang="en-CA"><head><meta charset="utf-8"><title>${esc(name)}</title><style>${reportStylesheetText()}</style></head><body class="is-report-print"><div class="report-root">${pages}</div></body></html>`);
  doc.close();
  const win = frame.contentWindow;
  const clearFrame = () => {
    win.removeEventListener("afterprint", clearFrame);
    setTimeout(() => {
      if (doc.body) doc.body.replaceChildren();
    }, 1500);
  };
  win.addEventListener("afterprint", clearFrame);
  win.focus();
  win.print();
}

function renderRoster(course) {
  const query = ui.search.trim().toLowerCase();
  const rows = sortedStudents(course)
    .filter((student) => !query || studentName(student).toLowerCase().includes(query))
    .map((student) => {
      const summary = summarizeStudent(course, student);
      const bars = LEVELS.map((level) => `<span class="lv-${level.id}">${summary.byLevel[level.id]}</span>`).join("");
      return `<article class="card summary-card">
        <a class="summary-row" href="${studentHref(course.id, student.id)}">
          <strong>${esc(studentName(student))}</strong>
          ${trendLine(summary.entries)}
          <div class="summary-side">
            <div class="tally" aria-label="Entries By Level">${bars}</div>
            <p class="sub">${summary.counts.conversation} conversations · ${summary.counts.observation} observations</p>
          </div>
        </a>
        <div class="summary-actions noprint">
          <button type="button" class="ghost" data-action="export-student-pdf" data-student="${esc(student.id)}">Export PDF Report</button>
        </div>
      </article>`;
    })
    .join("");
  return `<div class="stack">
    <button type="button" class="primary full-button noprint" data-action="export-class-pdf">Export All Reports</button>
    <label class="field noprint"><input id="roster-search" type="search" value="${esc(ui.search)}" placeholder="Find A Student" aria-label="Find A Student" /></label>
    <div class="summary-list">${rows || "<p>No students match.</p>"}</div>
    <p class="sub">The numbers are how many entries sit at each level, from Level 4 to below Level 1. The line is each recorded percent, oldest to newest. Neither one is a calculated mark.</p>
  </div>`;
}

function showEntryPhoto(src) {
  modalEl.classList.add("photo-view");
  modalEl.innerHTML = `<form method="dialog"><h2>Photo</h2><img class="entry-photo" alt="Photo For This Entry" src="${src}" /><menu><button class="primary" value="close" type="submit">Close</button></menu></form>`;
  modalEl.addEventListener("close", () => modalEl.classList.remove("photo-view"), { once: true });
  modalEl.showModal();
}

function trendLine(entries) {
  const values = [...entries]
    .reverse()
    .map((entry) => Number(entry.percent))
    .filter((value) => Number.isFinite(value));
  const width = 120;
  const height = 36;
  const pad = 3;
  if (!values.length) {
    return `<svg class="trend is-empty" viewBox="0 0 ${width} ${height}" focusable="false" aria-hidden="true"></svg>`;
  }
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : pad + (index * (width - pad * 2)) / (values.length - 1);
    const clamped = Math.min(100, Math.max(0, value));
    const y = pad + ((100 - clamped) / 100) * (height - pad * 2);
    return [x.toFixed(1), y.toFixed(1)];
  });
  const path = coords.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join("");
  const dots = coords.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" />`).join("");
  const label = values.map((value) => `${Math.round(value)}%`).join(", ");
  return `<svg class="trend" viewBox="0 0 ${width} ${height}" focusable="false" role="img" aria-label="Recorded Percents, Oldest To Newest: ${esc(label)}"><title>${esc(label)}</title><path d="${path}" />${dots}</svg>`;
}

function levelScatter(entries) {
  const chronological = [...entries].reverse().filter((entry) => levelById(entry.level));
  const stamps = chronological.map((entry) => entryDay(entry.date));
  const min = stamps.length ? Math.min(...stamps) : 0;
  const span = stamps.length ? Math.max(...stamps) - min : 0;
  const groups = new Map();
  const placed = chronological.map((entry, index) => {
    const raw = span === 0 ? 0.5 : 0.08 + ((stamps[index] - min) / span) * 0.84;
    const level = String(entry.level);
    const key = `${raw.toFixed(4)}:${level}`;
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key);
    group.push(index);
    return { entry, raw, key, level };
  });
  const yLabels = [4, 3, 2, 1, 0]
    .map((level) => `<span class="scatter-ylabel" style="--y:${(4 - level) / 4}">${level}</span>`)
    .join("");
  const grids = [4, 3, 2, 1, 0]
    .map((level) => `<span class="scatter-grid" style="--y:${(4 - level) / 4}"></span>`)
    .join("");
  const dots = placed
    .map(({ entry, raw, key, level }, index) => {
      const group = groups.get(key);
      const slot = group.indexOf(index);
      const offset = (slot - (group.length - 1) / 2) * 0.045;
      const x = Math.min(0.96, Math.max(0.04, raw + offset));
      const y = (4 - Number(level)) / 4;
      const text = `${formatDate(entry.date)} · ${kindById(entry.kind).label} · ${levelById(level).name} · ${entry.percent}%`;
      return `<span class="scatter-point lv-${esc(level)}" style="--x:${x.toFixed(4)}; --y:${y}" title="${esc(text)}"></span>`;
    })
    .join("");
  const described = placed.length
    ? placed.map(({ entry, level }) => `${formatDate(entry.date)}, ${levelById(level).name}`).join("; ")
    : "No entries yet";
  return `<figure class="scatter">
    <div class="scatter-frame" role="img" aria-label="Scatter Of Recorded Levels, Oldest To Newest. ${esc(described)}">
      ${yLabels}
      <div class="scatter-area">${grids}${dots}</div>
    </div>
    <div class="scatter-dates">${scatterDates(placed, stamps, min, span)}</div>
  </figure>`;
}

function scatterDates(placed, stamps, min, span) {
  if (!placed.length) return "";
  const unique = [];
  placed.forEach((item, index) => {
    if (!unique.some((row) => row.date === item.entry.date)) unique.push({ date: item.entry.date, stamp: stamps[index] });
  });
  const shown = unique.length <= 5 ? unique : [unique[0], unique[Math.floor((unique.length - 1) / 2)], unique[unique.length - 1]];
  return shown
    .map((item) => {
      const x = span === 0 ? 0.5 : 0.08 + ((item.stamp - min) / span) * 0.84;
      const shift = x < 0.15 ? "0" : x > 0.85 ? "-100%" : "-50%";
      return `<span style="--x:${x.toFixed(4)}; --shift:${shift}">${esc(shortMonthDay(item.date))}</span>`;
    })
    .join("");
}

function entryDay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 0;
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

function shortMonthDay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [, month, day] = iso.split("-").map(Number);
  return `${months[month - 1]} ${day}`;
}

function averageLevel(entries) {
  const values = entries.map((entry) => Number(entry.level)).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function storedLevelValue(mark) {
  const direct = Number(mark?.levelValue);
  if (Number.isFinite(direct)) return Math.round(Math.min(4, Math.max(0, direct)) * 10) / 10;
  if (mark?.level != null && mark.level !== "" && levelById(mark.level)) return Number(mark.level);
  return null;
}

function levelSummaryText(value) {
  if (value == null) return "No levels recorded yet";
  const nearest = levelById(String(Math.min(4, Math.max(0, Math.round(value)))));
  return `${value.toFixed(1)} · ${nearest.name}`;
}

function percentFromLevelValue(value) {
  const stops = [40, 55, 65, 75, 90];
  const clamped = Math.min(4, Math.max(0, value));
  const lower = Math.floor(clamped);
  const upper = Math.ceil(clamped);
  return Math.round(stops[lower] + (stops[upper] - stops[lower]) * (clamped - lower));
}

function checkpointList(checkpoints) {
  const items = Array.isArray(checkpoints) ? checkpoints : [];
  if (!items.length) return `<p class="sub">No checkpoints saved.</p>`;
  return `<ul class="checkpoint-list">${items
    .map((item) => {
      const average = Number.isFinite(Number(item.average)) ? Number(item.average).toFixed(1) : "none";
      const used = Number.isFinite(Number(item.levelValue)) ? levelById(String(Math.round(Number(item.levelValue))))?.name || Number(item.levelValue).toFixed(1) : "none";
      const percent = Number.isFinite(Number(item.percent)) ? `${Math.round(Number(item.percent))}%` : "";
      const note = String(item.note || "").trim() ? `<p class="note">${esc(item.note)}</p>` : "";
      return `<li><strong>${esc(item.name)}</strong><p class="sub">${esc(formatDate(item.date))} · Average ${average} · ${esc(used)}${percent ? ` · ${percent}` : ""} · ${item.count || 0} ${Number(item.count) === 1 ? "entry" : "entries"}</p>${note}<button type="button" class="text-button" data-action="delete-checkpoint" data-checkpoint="${esc(item.id)}">Delete</button></li>`;
    })
    .join("")}</ul>`;
}

function chosenMark(mark, average) {
  const storedLevel = levelById(mark?.level) || (Number.isFinite(Number(mark?.levelValue)) ? levelById(String(Math.min(4, Math.max(0, Math.round(Number(mark.levelValue)))))) : null);
  if (storedLevel) {
    const percent = Number(mark?.percent);
    const value = Number.isFinite(percent) ? Math.round(percent) : storedLevel.midpoint;
    return { level: storedLevel, percent: Math.min(storedLevel.max, Math.max(storedLevel.min, value)), adjusted: true };
  }
  if (average == null) return { level: null, percent: null, adjusted: false };
  const level = levelById(String(Math.min(4, Math.max(0, Math.round(average)))));
  return { level, percent: Math.min(level.max, Math.max(level.min, percentFromLevelValue(average))), adjusted: false };
}

function renderStudent(course, student) {
  const summary = summarizeStudent(course, student);
  const mark = summary.mark || {};
  const average = averageLevel(summary.entries);
  const chosen = chosenMark(mark, average);
  const levelButtons = LEVELS.filter((item) => item.id !== "0")
    .map((item) => `<button type="button" class="level-btn" data-action="set-mark" data-student="${esc(student.id)}" data-level="${item.id}" aria-pressed="${chosen.level?.id === item.id}" ${chosen.level ? "" : "disabled"}><b>${item.short}</b><small>${item.band}</small></button>`)
    .join("");
  const groups = summary.expectations
    .map((item) => `<li><strong>${esc(item.label)}</strong> · ${item.count} ${item.count === 1 ? "entry" : "entries"}</li>`)
    .join("");
  return `<div class="stack">
    <div class="student-head">
      <a href="${hrefFor(course.id, "roster")}">← Summary</a>
      <div class="student-actions noprint">
        <button type="button" class="ghost" data-action="export-student-pdf" data-student="${esc(student.id)}">Export PDF Report</button>
        <a class="primary" href="${captureHref(course.id, student.id)}">Add Entry</a>
      </div>
      <h2 class="student-name">${esc(studentName(student))}</h2>
    </div>
    <section class="card">
      <div class="tally">${LEVELS.map((level) => `<span class="lv-${level.id}">${level.short} · ${summary.byLevel[level.id]}</span>`).join("")}</div>
      <p>${summary.counts.conversation} conversations and ${summary.counts.observation} observations. These are the counts at each level.</p>
      ${groups ? `<ul>${groups}</ul>` : `<p class="sub">No entries yet.</p>`}
    </section>
    <section class="card">
      <h2>Levels Over Time</h2>
      <p class="sub">Each point is one conversation or observation. The vertical axis is the achievement level, and 0 is below Level 1.</p>
      ${levelScatter(summary.entries)}
    </section>
    <section class="panel">
      <h2>Average Level</h2>
      <p class="readout" id="level-readout">${average == null ? "No levels recorded yet" : esc(levelSummaryText(average))}</p>
      <p class="sub">${average == null ? "Record a level before choosing one here." : `Average of the recorded levels: ${average.toFixed(1)} from ${summary.entries.length} ${summary.entries.length === 1 ? "entry" : "entries"}.`}</p>
      <div class="level-row">${levelButtons}</div>
      <button type="button" class="chip-btn below-btn" data-action="set-mark" data-student="${esc(student.id)}" data-level="0" aria-pressed="${chosen.level?.id === "0"}" ${chosen.level ? "" : "disabled"}>Below Level 1 · Under 50%</button>
      <label class="field">Percentage<input id="percent-slider" data-student="${esc(student.id)}" type="range" min="${chosen.level ? chosen.level.min : 0}" max="${chosen.level ? chosen.level.max : 100}" step="1" value="${chosen.percent ?? 0}" ${chosen.level ? "" : "disabled"} /></label>
      <p class="readout" id="percent-readout">${chosen.percent == null ? "" : `${chosen.percent}%`}</p>
      ${chosen.adjusted ? `<button type="button" class="text-button" data-action="use-average" data-student="${esc(student.id)}">Use The Average</button>` : ""}
      <label class="field">Notes<textarea id="mark-comment" data-student="${esc(student.id)}">${esc(mark.comment || "")}</textarea></label>
    </section>
    <section class="panel checkpoint-panel">
      <h2>Checkpoints</h2>
      <p class="sub">Save a snapshot for a report, such as a midterm. It keeps the average, the level, the percentage, and the notes as they are now.</p>
      <div class="row checkpoint-save">
        <label class="field">Checkpoint<input id="checkpoint-name" list="checkpoint-names" placeholder="Midterm Report" data-student="${esc(student.id)}" /></label>
        <button type="button" class="primary save" data-action="save-checkpoint" data-student="${esc(student.id)}">Save Checkpoint</button>
      </div>
      <datalist id="checkpoint-names">
        <option value="Progress report"></option>
        <option value="Midterm report"></option>
        <option value="Final report"></option>
      </datalist>
      ${checkpointList(mark.checkpoints)}
    </section>
    <section class="stack">
      <h2>Entries</h2>
      ${summary.entries.length ? summary.entries.map((entry) => entryCard(course, entry)).join("") : `<p class="sub">Nothing recorded yet.</p>`}
    </section>
  </div>`;
}

function driveIcon() {
  return `<svg viewBox="0 0 87.3 78" aria-hidden="true"><path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"/><path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z"/><path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"/><path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"/><path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"/><path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"/></svg>`;
}

function renderSetup(course) {
  const listedStudents = sortedStudents(course);
  const draft = ui.studentDraft[course.id];
  if (draft == null) ui.studentLineIds[course.id] = listedStudents.map((student) => student.id);
  const studentLines = draft != null ? draft : listedStudents.map((student) => studentName(student)).join("\n");
  const codeGrade = findOntarioCourse(course.code)?.grade ?? course.grade;
  return `<div class="stack">
    <div class="stack noprint setup-actions">
      <a class="primary setup-add" href="#/new">Create New Class</a>
      <button type="button" class="ghost drive-sync save" data-action="drive-backup">${driveIcon()} Manual Save to Google Drive</button>
      <p class="sub sync-time" id="last-sync">${esc(lastSyncText())}</p>
    </div>
    <form class="card form-grid" data-action="save-course">
      <h2 class="span-2">COURSE DETAILS</h2>
      ${courseCodeFields(course.code)}
      <label class="field">Course Title<input name="name" type="text" value="${esc(course.name)}" required /></label>
      <label class="field">Grade<select name="grade">${gradeOptions(codeGrade)}</select></label>
      <label class="field">Semester<input name="semester" type="text" value="${esc(course.semesterLabel)}" /></label>
      ${periodField(course.period)}
      <div class="span-2">
        <button class="primary full-button save" type="submit">Save Course Details</button>
      </div>
    </form>
    <section class="card stack">
      <div class="expect-lead">
        <h2>EXPECTATIONS</h2>
        <p>Add custom expectations by simply adding them to the list below. One expectation per line only.</p>
      </div>
      <button type="button" class="primary full-button" data-action="reload-expectations">Load Expectations From Curriculum</button>
      <button type="button" class="primary full-button" data-action="load-learning-skills">Load Learning Skills</button>
      <textarea id="expectation-list" aria-label="Expectations For This Class, One Per Line" rows="${Math.max(8, loadedExpectations(course).length + 1)}" spellcheck="false">${esc(loadedExpectations(course).map((item) => item.label).join("\n"))}</textarea>
      <button type="button" class="primary save" data-action="save-expectation-list">Save Expectation List</button>
    </section>
    <section class="card stack">
      <h2>STUDENT LIST (<span class="course-code-mark">${esc(course.code)}</span>)</h2>
      <textarea id="student-list" aria-label="Students, One Name Per Line" rows="${Math.max(8, sortedStudents(course).length + 1)}" spellcheck="false">${esc(studentLines)}</textarea>
      <button type="button" class="primary save" data-action="save-student-list">Save Student List</button>
      <p class="sub">One student per line. Change a name, add a line, or delete a line, then press Save Student List.</p>
    </section>
    <section class="card">
      <button type="button" class="danger full-button" data-action="delete-course">Delete ${esc(course.code || course.name)}</button>
    </section>
    <section class="card stack" id="google-panel">
      <h2 class="google-setup-title">${driveIcon()} GOOGLE DRIVE SETUP</h2>
      <label class="field">Active Google Account<input id="google-account-email" type="text" readonly value="${esc(googleEmail(sessionStorage.getItem("class-record-google-account")))}" placeholder="Log in to Google Account Below" /></label>
      <label class="field">Google Folder<input id="google-folder-name" type="text" readonly value="${esc(storedFolder()?.name || "")}" placeholder="No Folder Chosen" /></label>
      <div class="row">
        <button type="button" class="ghost drive-mark" data-action="google-sign-in">${driveIcon()} <span id="google-sign-in-label">${googleAccountReady() ? "Connected" : "Sign In"}</span></button>
        <button type="button" class="primary" data-action="select-drive-folder">Select Drive Folder</button>
      </div>
      <div id="drive-browser"></div>
    </section>
    <div class="stack">
      <h2>BACKUP / RESTORE CLASS DATA</h2>
      <button type="button" class="ghost full-button csv-action" data-action="import">Import Class from CSV File</button>
      <button type="button" class="ghost full-button csv-action" data-action="email-backup">Backup Class to CSV File</button>
    </div>
  </div>`;
}

function saveCapture(course) {
  const capture = ui.capture;
  if (!capture || !capture.touched) {
    showToast("Choose a level.");
    return;
  }
  const customField = document.getElementById("custom-expectation");
  if (customField && capture.expectationId === "custom") capture.customText = customField.value;
  if (!expectationReady(course, capture)) {
    showToast("Choose an expectation, or write a custom one.");
    render();
    return;
  }
  let expectationId = capture.expectationId;
  let expectationLabel = "";
  if (capture.expectationId === "custom") {
    const text = capture.customText.trim();
    expectationLabel = text;
    if (capture.saveCustom) {
      const label = buttonLabel(text);
      const existing = course.expectations.find((item) => item.label.toLowerCase() === label.toLowerCase() || item.detail.trim().toLowerCase() === text.toLowerCase());
      if (existing) {
        expectationId = existing.id;
        expectationLabel = existing.detail || existing.label;
      } else {
        const created = { id: uid("exp"), label, detail: text };
        course.expectations.push(created);
        expectationId = created.id;
        expectationLabel = created.detail;
      }
    } else expectationId = null;
    const draft = classDraft(course.id);
    draft.text = "";
    draft.saveCustom = true;
  } else {
    const found = knownExpectation(course, capture.expectationId);
    expectationLabel = found?.label || "Expectation";
  }
  const date = capture.date || ui.date;
  const session = ensureSession(course, date);
  const payload = {
    sessionId: session.id,
    date,
    studentId: capture.studentId,
    kind: capture.kind,
    expectationId,
    expectationLabel,
    level: levelFromPercent(capture.percent).id,
    percent: Number(capture.percent),
    note: capture.note.trim(),
    photo: photoSrc(capture.photo),
  };
  if (capture.entryId) {
    const existing = course.entries.find((item) => item.id === capture.entryId);
    if (existing) Object.assign(existing, payload);
  } else {
    course.entries.push({ id: uid("ev"), createdAt: new Date().toISOString(), ...payload });
  }
  ui.stick = { kind: payload.kind, expectationId: expectationId || ui.stick.expectationId };
  if (expectationId) ui.focus[course.id] = expectationId;
  else if (ui.focus[course.id] === "custom") ui.focus[course.id] = "";
  ui.capture = null;
  persist();
  showToast(`${kindById(payload.kind).label} saved · ${levelById(payload.level).name}`);
  warnIfGoogleMissing();
  const next = hrefFor(course.id);
  if ((location.hash || "#/") !== next) location.hash = next;
  else render();
}

function ensureMark(course, studentId) {
  if (!course.marks[studentId]) course.marks[studentId] = { level: null, percent: null, comment: "" };
  return course.marks[studentId];
}

function classExports() {
  const used = new Set();
  return (db.courses || []).map((course) => {
    let name = classCsvName(course);
    if (used.has(name)) name = name.replace(/\.csv$/, ` ${String(course.id || "").slice(-4)}.csv`);
    used.add(name);
    const csv = courseToCsv(course);
    return { name, csv, file: new File([csv], name, { type: "text/csv" }) };
  });
}

function downloadCsvFile(name, csv) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadClassFiles() {
  const files = classExports();
  files.forEach((item, index) => {
    window.setTimeout(() => downloadCsvFile(item.name, item.csv), index * 400);
  });
  return files.map((item) => item.name);
}

async function saveClassesToFolder(token, folderId) {
  const files = classExports();
  if (!files.length) throw new Error("There is no class to save.");
  for (const item of files) await uploadToFolder(token, folderId, item.name, item.csv);
  return files.map((item) => item.name);
}

function savedClassMessage(names, folderName) {
  if (names.length === 1) return `Saved ${names[0]} in ${folderName}.`;
  return `Saved ${names.length} class files in ${folderName}.`;
}

function chooseBackupMode() {
  modalEl.innerHTML = `<form method="dialog"><h2>Backup Class to CSV File</h2><p>Email the CSV file, or download it.</p><menu class="stack-menu">
    <button class="primary" value="email" type="submit">Email the CSV File</button>
    <button class="primary" value="download" type="submit">Download the CSV File</button>
    <button class="ghost" value="cancel" type="submit">Cancel</button>
  </menu></form>`;
  modalEl.showModal();
  return new Promise((resolve) => {
    let choice = "";
    modalEl.querySelectorAll("button[value]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.value === "email" || button.value === "download" || button.value === "cancel") choice = button.value;
      });
    });
    modalEl.addEventListener("close", () => {
      const value = choice || modalEl.returnValue;
      resolve(value === "email" || value === "download" ? value : "");
    }, { once: true });
  });
}

function askEmail() {
  const preset = googleEmail(sessionStorage.getItem("class-record-google-account")) || db.backupEmail || "";
  modalEl.innerHTML = `<form method="dialog"><h2>Email The CSV</h2><p>Each class is its own file, named with the course code, the semester and year, and the period. The files download, then your mail app opens. Attach the CSVs to the message.</p><label class="field">Email Address<input id="backup-email" type="email" required value="${esc(preset)}" placeholder="name@school.ca" /></label><menu><button class="ghost" value="cancel" type="submit">Cancel</button><button class="primary" value="ok" type="submit">Email CSV</button></menu></form>`;
  const input = modalEl.querySelector("#backup-email");
  modalEl.showModal();
  input.focus();
  return new Promise((resolve) => {
    modalEl.addEventListener("close", () => resolve(modalEl.returnValue === "ok" ? input.value.trim() : ""), { once: true });
  });
}

async function emailBackup() {
  const email = await askEmail();
  if (!email) return;
  db.backupEmail = email;
  persist();
  const files = classExports();
  if (!files.length) {
    showToast("There is no class to save.");
    return;
  }
  if (navigator.canShare?.({ files: files.map((item) => item.file) })) {
    try {
      await navigator.share({ files: files.map((item) => item.file), title: "Class Record backup", text: `Class Record backup for ${email}` });
      showToast(`Shared. Send the CSV files to ${email}.`);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  const names = downloadClassFiles();
  window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Class Record backup")}&body=${encodeURIComponent(`Attach ${names.join(", ")}. Import a file to update that class. Other classes stay.`)}`;
  showToast("CSV files downloaded. Attach them to the email.");
}

async function backupClassFiles() {
  const choice = await chooseBackupMode();
  if (!choice) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (choice === "download") {
    const names = downloadClassFiles();
    if (!names.length) {
      showToast("There is no class to save.");
      return;
    }
    showToast(names.length === 1 ? "CSV file downloaded." : `${names.length} CSV files downloaded.`);
    return;
  }
  return emailBackup();
}

function googleEmail(value) {
  const clean = String(value || "").trim().slice(0, 120);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : "";
}

function storedFolder() {
  try {
    const folder = JSON.parse(localStorage.getItem("class-record-google-folder") || "");
    if (!folder?.id) return null;
    return { id: String(folder.id), name: String(folder.name || "Folder").slice(0, 120) };
  } catch {
    return null;
  }
}

function rememberFolder(folder) {
  const saved = { id: String(folder.id), name: String(folder.name || "Folder").slice(0, 120) };
  localStorage.setItem("class-record-google-folder", JSON.stringify(saved));
  const input = document.getElementById("google-folder-name");
  if (input) input.value = saved.name;
}

function refreshGoogleFields() {
  const email = document.getElementById("google-account-email");
  const folder = document.getElementById("google-folder-name");
  const signIn = document.getElementById("google-sign-in-label");
  if (email) email.value = googleEmail(sessionStorage.getItem("class-record-google-account")) || "";
  if (folder) folder.value = storedFolder()?.name || "";
  if (signIn) signIn.textContent = googleAccountReady() ? "Connected" : "Sign In";
}

function openDriveBrowser() {
  const saved = storedGoogleToken();
  const browser = document.getElementById("drive-browser");
  if (!browser) return;
  if (!saved?.token || !canListDrive(saved.scope)) {
    showToast("Sign in first.");
    return;
  }
  const trail = [{ id: "root", name: "My Drive" }];
  let pages = [];
  const draw = async ({ more = false } = {}) => {
    const current = trail[trail.length - 1];
    const pageToken = more ? pages.at(-1)?.nextPageToken || "" : "";
    if (!more) pages = [];
    browser.replaceChildren();
    const path = document.createElement("p");
    path.className = "drive-path";
    trail.forEach((folder, index) => {
      if (index) path.append(document.createTextNode(" / "));
      if (index === trail.length - 1) {
        const here = document.createElement("span");
        here.textContent = folder.name;
        path.append(here);
      } else {
        const crumb = document.createElement("button");
        crumb.type = "button";
        crumb.textContent = folder.name;
        crumb.addEventListener("click", () => {
          trail.splice(index + 1);
          draw();
        });
        path.append(crumb);
      }
    });
    const status = document.createElement("p");
    status.className = "folder-status";
    status.textContent = "Opening folders…";
    browser.append(path, status);
    try {
      const page = await listFolders(saved.token, current.id, pageToken);
      pages.push(page);
      status.remove();
      const list = document.createElement("div");
      list.className = "folder-list";
      const folders = pages.flatMap((item) => item.folders);
      if (!folders.length) {
        const empty = document.createElement("p");
        empty.className = "folder-status";
        empty.textContent = "No folders here.";
        list.append(empty);
      }
      for (const folder of folders) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost";
        button.textContent = folder.name;
        button.addEventListener("click", () => {
          trail.push(folder);
          draw();
        });
        list.append(button);
      }
      if (page.nextPageToken) {
        const moreButton = document.createElement("button");
        moreButton.type = "button";
        moreButton.className = "ghost";
        moreButton.textContent = "More Folders";
        moreButton.addEventListener("click", () => draw({ more: true }));
        list.append(moreButton);
      }
      const createRow = document.createElement("div");
      createRow.className = "drive-create";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "New Folder Name";
      nameInput.setAttribute("aria-label", "New Folder Name");
      const createButton = document.createElement("button");
      createButton.type = "button";
      createButton.className = "ghost";
      createButton.textContent = "Create";
      createButton.addEventListener("click", async () => {
        createButton.disabled = true;
        try {
          const created = await createDriveFolder(saved.token, current.id, nameInput.value);
          trail.push(created);
          draw();
        } catch (error) {
          showToast(error.message || "The folder could not be created.");
          if (createButton.isConnected) createButton.disabled = false;
        }
      });
      createRow.append(nameInput, createButton);
      const useFolder = document.createElement("button");
      useFolder.type = "button";
      useFolder.className = "primary";
      useFolder.textContent = "Use This Folder";
      useFolder.addEventListener("click", () => {
        rememberFolder(current);
        browser.replaceChildren();
        showToast(`Google folder set to ${current.name}.`);
      });
      browser.append(list, createRow, useFolder);
    } catch (error) {
      status.textContent = error.message || "The folders could not be opened.";
    }
  };
  draw();
}

async function selectDriveFolder(button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    if (await beginDriveFolder()) return;
    openDriveBrowser();
  } catch (error) {
    showToast(error.message || "The folders could not be opened.");
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

async function driveBackup() {
  if (driveBackup.running) return;
  if (!googleAccountReady()) {
    scrollToGoogleSetup();
    return;
  }
  const folder = storedFolder();
  if (!folder) {
    showToast("Choose a Google Drive folder below.");
    scrollToGoogleSetup();
    return;
  }
  driveBackup.running = true;
  try {
    if (await beginDriveFolder()) {
      sessionStorage.setItem("class-record-google-save", "1");
      return;
    }
    const saved = storedGoogleToken();
    if (!saved?.token) {
      showToast("Sign in first.");
      return;
    }
    const names = await saveClassesToFolder(saved.token, folder.id);
    noteDriveSync();
    showToast(savedClassMessage(names, folder.name));
  } catch (error) {
    showToast(error.message || "The backup could not be saved.");
  } finally {
    driveBackup.running = false;
  }
}

function syncSlider() {
  const capture = ui.capture;
  const save = document.getElementById("save-entry");
  if (!capture || !save) return;
  const route = parseRoute();
  const course = courseById(route.courseId);
  const level = levelFromPercent(capture.percent);
  if (capture.touched) capture.level = level.id;
  for (const button of appEl.querySelectorAll("[data-action='pick-level']")) {
    button.setAttribute("aria-pressed", capture.touched && button.dataset.level === level.id ? "true" : "false");
  }
  const ready = capture.touched && course && expectationReady(course, capture);
  save.disabled = !ready;
  save.textContent = ready ? "Save Entry" : course && expectationReady(course, capture) ? "Choose Level To Save Entry" : "No Expectation Selected";
}

async function onClick(event) {
  if (ignoreClick) {
    ignoreClick = false;
    event.preventDefault();
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target || !appEl.contains(target)) return;
  const action = target.dataset.action;
  const route = parseRoute();
  const course = courseById(route.courseId);

  if (action === "email-backup") return backupClassFiles();
  if (action === "drive-backup") return driveBackup();
  if (action === "google-sign-in") {
    beginGoogleSignIn().catch((error) => showToast(error.message || "Google sign-in did not finish."));
    return;
  }
  if (action === "select-drive-folder") return selectDriveFolder(target);
  if (action === "import") return importEl.click();
  if (action === "export-student-pdf" && course) {
    const student = studentById(course, target.dataset.student);
    if (student) exportReports(course, [student]);
    return;
  }
  if (action === "export-class-pdf" && course) return exportReports(course, sortedStudents(course));
  if (action === "grip") return;
  if (action === "toggle-student-view") {
    ui.studentView = ui.studentView === "list" ? "tiles" : "list";
    render();
    return;
  }
  if (action === "reload-expectations" && course) {
    const code = loadCourseCode || codeFromCourseSelect() || catalogueCode(course.code);
    loadCourseCode = "";
    loadingExpectations = true;
    if (!code) {
      loadingExpectations = false;
      showToast("Choose an Ontario course code first.");
      return;
    }
    const existing = visibleExpectations(course);
    const progress = showCurriculumProgress();
    const controller = new AbortController();
    progress.whenClosed.then((cancelled) => { if (cancelled) controller.abort(); });
    let payload = null;
    try {
      payload = await fetchCurriculumDocument(code, controller.signal);
    } catch (error) {
      if (progress.cancelled || error?.name === "AbortError") {
        progress.finish();
        loadingExpectations = false;
        return;
      }
      const local = expectationsForCode(code, { includeSpecific: true });
      progress.finish();
      if (error.offline && local.items.length) {
        payload = {
          citation: local.citation,
          hasSpecific: local.hasSpecific,
          items: local.items.map((item) => ({
            ...item,
            strand: item.group || "",
            specific: /\d+\.\d+/.test(item.label.split(" ")[0]),
          })),
        };
        showToast("The curriculum site did not respond. The list saved in the app was used.");
      } else {
        loadingExpectations = false;
        showToast(error.message || `No expectations were found in the curriculum document for ${code}.`);
        return;
      }
    }
    if (progress.cancelled) {
      progress.finish();
      loadingExpectations = false;
      return;
    }
    progress.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!payload?.items?.length) {
      loadingExpectations = false;
      showToast(`No expectations were found in the curriculum document for ${code}.`);
      return;
    }
    const choice = payload.hasSpecific ? await chooseExpectationDepth(true) : "overall";
    if (!choice) {
      loadingExpectations = false;
      return;
    }
    const mode = await chooseListMode("Load Expectations", "Replace the current list, or add these expectations to it?");
    if (!mode) {
      loadingExpectations = false;
      return;
    }
    const curriculum = {
      citation: payload.citation || "",
      items: curriculumLines(payload, choice === "specific"),
    };
    course.code = code;
    const catalogue = findOntarioCourse(course.code);
    if (catalogue) {
      course.gradeLabel = catalogue.gradeLabel;
      if (!course.name || course.name === "Untitled course") course.name = catalogue.title;
    }
    if (!applyCatalogueExpectations(course, { mode, existing, curriculum })) {
      loadingExpectations = false;
      showToast(`No expectations were found in the curriculum document for ${code}.`);
      return;
    }
    persist();
    const depth = choice === "specific" ? "Overall and specific expectations" : "Overall expectations";
    showToast(mode === "add" ? `${depth} added for ${course.code}.` : `${depth} loaded for ${course.code}.`);
    render();
    setTimeout(() => { loadingExpectations = false; }, 0);
    return;
  }
  if (action === "load-learning-skills" && course) {
    loadingExpectations = true;
    const existing = visibleExpectations(course);
    const choice = await chooseLearningSkillMode();
    if (!choice) {
      loadingExpectations = false;
      return;
    }
    applyLearningSkills(course, choice, existing);
    persist();
    showToast(choice === "add" ? "Learning skills added." : "Learning skills loaded.");
    render();
    setTimeout(() => { loadingExpectations = false; }, 0);
    return;
  }
  if (action === "erase-all") {
    const ok = await confirmAction("Erase every course stored in this browser?", "Erase");
    if (!ok) return;
    db = emptyState();
    persist();
    if ((location.hash || "#/") !== "#/") location.hash = "#/";
    else render();
    showToast("Browser record erased.");
    return;
  }
  if (!course) return;

  if (action === "view-photo") {
    const entry = course.entries.find((item) => item.id === target.dataset.entry);
    const src = photoSrc(entry?.photo);
    if (src) showEntryPhoto(src);
    return;
  }
  if (action === "save-expectation-list") {
    const saved = syncExpectationList(course, document.getElementById("expectation-list")?.value || "");
    if (saved === false) showToast("Saved.");
    return;
  }
  if (action === "save-student-list") {
    const saved = await syncStudentList(course, document.getElementById("student-list")?.value || "");
    if (saved === false) showToast("Saved.");
    return;
  }
  if (action === "set-focus") {
    ui.focus[course.id] = ui.focus[course.id] === target.dataset.expectation ? "" : target.dataset.expectation;
    render();
    return;
  }
  if (action === "pick-kind" && ui.capture) {
    ui.capture.kind = target.dataset.kind;
    render();
    return;
  }
  if (action === "add-photo") {
    document.getElementById("entry-photo")?.click();
    return;
  }
  if (action === "add-note" && ui.capture) {
    ui.capture.showNote = true;
    render();
    document.getElementById("entry-note")?.focus();
    return;
  }
  if (action === "remove-photo" && ui.capture) {
    ui.capture.photo = "";
    render();
    return;
  }
  if (action === "pick-expectation" && ui.capture) {
    ui.capture.expectationId = target.dataset.expectation;
    render();
    return;
  }
  if (action === "pick-level" && ui.capture) {
    const level = levelById(target.dataset.level);
    ui.capture.level = level.id;
    ui.capture.percent = level.midpoint;
    ui.capture.touched = true;
    const customField = document.getElementById("custom-expectation");
    if (customField) ui.capture.customText = customField.value;
    if (course && ui.capture.expectationId === "custom" && ui.capture.saveCustom && expectationReady(course, ui.capture)) {
      saveCapture(course);
      return;
    }
    render();
    return;
  }
  if (action === "delete-entry") {
    const ok = await confirmAction("Delete this entry?");
    if (!ok) return;
    course.entries = course.entries.filter((entry) => entry.id !== target.dataset.entry);
    persist();
    showToast("Entry deleted.");
    render();
    return;
  }
  if (action === "delete-course") {
    const ok = await confirmAction(`Delete ${course.code || course.name} and its entries?`);
    if (!ok) return;
    db.courses = db.courses.filter((item) => item.id !== course.id);
    db.lastCourseId = db.courses[0]?.id || null;
    persist();
    location.hash = db.lastCourseId ? hrefFor(db.lastCourseId, keptTab) : "#/";
    showToast("Course deleted.");
    return;
  }
  if (action === "delete-student") {
    const student = studentById(course, target.dataset.student);
    const ok = await confirmAction(`Remove ${student ? studentName(student) : "this student"} and their entries?`);
    if (!ok) return;
    const studentId = target.dataset.student;
    course.students = course.students.filter((item) => item.id !== studentId);
    course.entries = course.entries.filter((item) => item.studentId !== studentId);
    delete course.marks[studentId];
    persist();
    showToast("Student removed.");
    render();
    return;
  }
  if (action === "delete-expectation") {
    const item = course.expectations.find((expectation) => expectation.id === target.dataset.expectation);
    const ok = await confirmAction(`Remove the “${item?.label || "expectation"}” button? Entries already saved will keep their wording.`);
    if (!ok) return;
    course.expectations = course.expectations.filter((expectation) => expectation.id !== target.dataset.expectation);
    if (ui.focus[course.id] === target.dataset.expectation) ui.focus[course.id] = "";
    persist();
    render();
    return;
  }
  if (action === "set-mark") {
    const record = ensureMark(course, target.dataset.student);
    const level = levelById(target.dataset.level);
    record.level = level.id;
    record.percent = level.midpoint;
    record.levelValue = Number(level.id);
    persist();
    render();
    return;
  }
  if (action === "use-average") {
    const record = ensureMark(course, target.dataset.student);
    delete record.levelValue;
    record.level = null;
    record.percent = null;
    persist();
    render();
    return;
  }
  if (action === "save-checkpoint") {
    const studentId = target.dataset.student;
    const name = document.getElementById("checkpoint-name")?.value.trim() || "";
    if (!name) {
      showToast("Name the checkpoint.");
      return;
    }
    const record = ensureMark(course, studentId);
    const entries = course.entries.filter((entry) => entry.studentId === studentId);
    const average = averageLevel(entries);
    const choice = chosenMark(record, average);
    if (!record.checkpoints) record.checkpoints = [];
    record.checkpoints.unshift({
      id: uid("chk"),
      name,
      date: todayISO(),
      average,
      levelValue: choice.level ? Number(choice.level.id) : average,
      percent: choice.percent,
      note: record.comment || "",
      count: entries.length,
      createdAt: new Date().toISOString(),
    });
    persist();
    showToast(`Checkpoint saved: ${name}.`);
    warnIfGoogleMissing();
    render();
    return;
  }
  if (action === "delete-checkpoint") {
    const studentId = route.studentId;
    const record = studentId ? course.marks?.[studentId] : null;
    if (!record?.checkpoints) return;
    const checkpoint = record.checkpoints.find((item) => item.id === target.dataset.checkpoint);
    const ok = await confirmAction(`Delete the “${checkpoint?.name || "checkpoint"}” snapshot?`);
    if (!ok) return;
    record.checkpoints = record.checkpoints.filter((item) => item.id !== target.dataset.checkpoint);
    persist();
    showToast("Checkpoint deleted.");
    render();
  }
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !appEl.contains(form)) return;
  event.preventDefault();
  const data = new FormData(form);
  const route = parseRoute();
  const course = courseById(route.courseId);
  const action = form.dataset.action;

  if (action === "save-form") {
    if (course) saveCapture(course);
    return;
  }
  if (action === "create-course") {
    const code = String(data.get("code") || "").trim().toUpperCase();
    const catalogue = findOntarioCourse(code);
    const students = String(data.get("students") || "")
      .split("\n")
      .map(parseStudentLine)
      .filter(Boolean)
      .map((student, index) => ({ id: uid("stu"), preferredName: "", seat: index, ...student }));
    const created = normalizeCourse({
      id: uid("course"),
      name: String(data.get("name") || catalogue?.title || ""),
      code,
      grade: Number(data.get("grade") || catalogue?.grade),
      gradeLabel: catalogue?.gradeLabel || "",
      semesterLabel: String(data.get("semester") || ""),
      period: periodValue(data.get("period")),
      students,
      expectations: expectationsForCode(code).items.map((item) => ({ id: item.id, label: item.label, detail: item.detail, group: item.group || "" })),
      expectationsManaged: true,
      sessions: [],
      entries: [],
      marks: {},
    });
    if (!created.expectations.length) created.expectations = normalizeCourse({ expectations: undefined }).expectations;
    db.courses.push(created);
    db.lastCourseId = created.id;
    persist();
    location.hash = hrefFor(created.id, keptTab);
    ui.draftCode = "";
    ui.codeQuery = "";
    showToast("Class created.");
    warnIfGoogleMissing();
    return;
  }
  if (!course) return;
  if (action === "save-course") {
    const nextCode = String(data.get("code") || "").trim().toUpperCase();
    const catalogue = findOntarioCourse(nextCode);
    course.name = String(data.get("name") || "").trim() || catalogue?.title || "Untitled course";
    course.code = nextCode;
    course.grade = Number(data.get("grade"));
    course.gradeLabel = catalogue?.gradeLabel || course.gradeLabel;
    course.semesterLabel = String(data.get("semester") || "").trim();
    course.period = periodValue(data.get("period"));
    ui.draftCode = "";
    ui.codeQuery = "";
    persist();
    showToast("Course saved.");
    warnIfGoogleMissing();
    render();
    return;
  }
}

function syncExpectationList(course, text, options = {}) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const current = loadedExpectations(course);
  if (lines.join("\n") === current.map((item) => item.label).join("\n")) return false;
  const used = new Set();
  const assigned = lines.map((line) => {
    const found = current.find((item) => !used.has(item.id) && item.label.toLowerCase() === line.toLowerCase());
    if (!found) return null;
    used.add(found.id);
    return found;
  });
  const openLines = assigned.flatMap((item, index) => (item ? [] : [index]));
  const openItems = current.filter((item) => !used.has(item.id));
  const pairCount = Math.min(openLines.length, openItems.length);
  for (let index = 0; index < pairCount; index += 1) {
    const item = openItems[index];
    item.label = lines[openLines[index]];
    assigned[openLines[index]] = item;
    used.add(item.id);
  }
  for (let index = pairCount; index < openLines.length; index += 1) {
    const label = lines[openLines[index]];
    assigned[openLines[index]] = { id: uid("exp"), label, detail: label, group: "" };
  }
  course.expectations = assigned.filter(Boolean).map((item) => ({
    id: item.id,
    label: item.label,
    detail: item.detail || item.label,
    group: item.group || "",
  }));
  course.expectationsManaged = true;
  if (ui.focus[course.id] !== "custom" && !course.expectations.some((item) => item.id === ui.focus[course.id])) ui.focus[course.id] = "";
  if (ui.stick.expectationId && !course.expectations.some((item) => item.id === ui.stick.expectationId)) ui.stick.expectationId = null;
  persist();
  showToast("Expectation list saved.");
  warnIfGoogleMissing();
  if (options.render !== false) render();
  return true;
}

async function syncStudentList(course, text, options = {}) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const byId = new Map(course.students.map((student) => [student.id, student]));
  const previous = (ui.studentLineIds[course.id] || sortedStudents(course).map((student) => student.id))
    .map((id) => byId.get(id))
    .filter(Boolean);
  if (lines.join("\n") === previous.map((student) => studentName(student)).join("\n")) {
    delete ui.studentDraft[course.id];
    return false;
  }
  const used = new Set();
  const assigned = lines.map((line) => {
    const found = previous.find((student) => !used.has(student.id) && studentName(student).toLowerCase() === line.toLowerCase());
    if (!found) return null;
    used.add(found.id);
    return found;
  });
  lines.forEach((line, index) => {
    if (assigned[index]) return;
    const sameLine = previous[index];
    const parsed = sameLine && !used.has(sameLine.id) ? parseStudentLine(line) : null;
    if (!parsed) return;
    sameLine.firstName = parsed.firstName;
    sameLine.lastName = parsed.lastName;
    sameLine.preferredName = "";
    used.add(sameLine.id);
    assigned[index] = sameLine;
  });
  const openLines = assigned.flatMap((student, index) => (student ? [] : [index]));
  const openStudents = previous.filter((student) => !used.has(student.id));
  const pairCount = Math.min(openLines.length, openStudents.length);
  for (let index = 0; index < pairCount; index += 1) {
    const student = openStudents[index];
    const parsed = parseStudentLine(lines[openLines[index]]);
    student.firstName = parsed.firstName;
    student.lastName = parsed.lastName;
    student.preferredName = "";
    assigned[openLines[index]] = student;
    used.add(student.id);
  }
  let nextSeat = course.students.reduce((max, student) => Math.max(max, student.seat), -1) + 1;
  for (let index = pairCount; index < openLines.length; index += 1) {
    const parsed = parseStudentLine(lines[openLines[index]]);
    assigned[openLines[index]] = {
      id: uid("stu"),
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      preferredName: "",
      seat: nextSeat,
    };
    nextSeat += 1;
  }
  const removed = previous.filter((student) => !used.has(student.id));
  if (removed.length) {
    const ok = await confirmAction(`Remove ${removed.map((student) => studentName(student)).join(", ")} and their entries?`);
    if (!ok) {
      delete ui.studentDraft[course.id];
      render();
      return null;
    }
    const removedIds = new Set(removed.map((student) => student.id));
    course.entries = course.entries.filter((entry) => !removedIds.has(entry.studentId));
    for (const id of removedIds) delete course.marks[id];
  }
  course.students = assigned.filter(Boolean);
  ui.studentLineIds[course.id] = course.students.map((student) => student.id);
  delete ui.studentDraft[course.id];
  persist();
  showToast("Student list saved.");
  warnIfGoogleMissing();
  if (options.render !== false) render();
  return true;
}

function onChange(event) {
  const target = event.target;
  const route = parseRoute();
  const course = courseById(route.courseId);
  if (target.id === "entry-photo" && ui.capture) {
    const file = target.files?.[0];
    target.value = "";
    if (!file) return;
    readPhotoFile(file).then((photo) => {
      if (!ui.capture) return;
      ui.capture.photo = photo;
      render();
    }).catch(() => showToast("That photo could not be added."));
    return;
  }
  if (target.id === "student-list-pick" && course && target.value) {
    if (studentById(course, target.value)) location.hash = captureHref(course.id, target.value);
    return;
  }
  if (target.id === "class-switch") {
    const nextId = target.value;
    if (!nextId || nextId === route.courseId) return;
    location.hash = hrefFor(nextId, tabName(route) || keptTab);
    return;
  }
  if (target.id === "focus-expectation" && course) {
    ui.focus[course.id] = target.value;
    render();
    return;
  }
  if (target.id === "expectation-select" && ui.capture) {
    ui.capture.expectationId = target.value || null;
    render();
    return;
  }
  if (target.id === "seat-columns" && course) {
    const columns = Number(target.value);
    if (columns >= 2 && columns <= 8) {
      course.seatColumns = columns;
      persist();
      render();
    }
    return;
  }
  if (target.id === "seat-rows" && course) {
    const rows = Number(target.value);
    if (rows >= 1 && rows <= 8) {
      course.seatRows = rows;
      persist();
      render();
    }
    return;
  }
  if (target.id === "week-start" && course) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(target.value)) {
      course.weekStart = target.value;
      persist();
      render();
    }
    return;
  }
  if (target.id === "weekly-target" && course) {
    const count = Number(target.value);
    if (count >= 0 && count <= 10) {
      course.weeklyTarget = count;
      persist();
      render();
    }
    return;
  }
  if (target.id === "course-code") {
    ui.draftCode = target.value;
    const catalogue = findOntarioCourse(target.value);
    const form = target.closest("form");
    if (catalogue && form) {
      const grade = form.querySelector("[name=grade]");
      if (grade) grade.value = String(catalogue.grade);
      if (form.dataset.action === "create-course") {
        const name = form.querySelector("[name=name]");
        if (name) name.value = catalogue.title;
      }
    }
    return;
  }
  if (target.id === "class-date") {
    ui.date = target.value || todayISO();
    render();
    return;
  }
  if (target.id === "expectation-list" && course) {
    if (loadingExpectations || !target.isConnected) return;
    syncExpectationList(course, target.value, { render: true });
    return;
  }
  if (target.id === "class-topic" && course) {
    const session = ensureSession(course, ui.date);
    session.topic = target.value.trim();
    persist();
    warnIfGoogleMissing();
    render();
    return;
  }
  if (target.id === "save-custom" && ui.capture) {
    ui.capture.saveCustom = target.checked;
    return;
  }
  if (target.id === "class-save-custom" && course) {
    classDraft(course.id).saveCustom = target.checked;
    return;
  }
  if (!course) return;
  if (target.dataset.action === "rename") {
    const student = studentById(course, target.dataset.student);
    if (!student) return;
    student[target.dataset.field] = target.value.trim();
    persist();
    return;
  }
  if (target.dataset.action === "edit-expectation") {
    const item = course.expectations.find((expectation) => expectation.id === target.dataset.expectation);
    if (!item) return;
    item[target.dataset.field] = target.value.trim() || item[target.dataset.field];
    persist();
    return;
  }
  if (target.id === "percent-slider") {
    const record = ensureMark(course, target.dataset.student);
    const level = levelById(record.level) || levelFromPercent(record.percent);
    const value = Math.round(Number(target.value));
    const percent = level ? Math.min(level.max, Math.max(level.min, value)) : value;
    record.percent = percent;
    if (level) {
      record.level = level.id;
      record.levelValue = Number(level.id);
    }
    const readout = document.getElementById("percent-readout");
    if (readout) readout.textContent = `${percent}%`;
    persist();
    render();
    return;
  }
  if (target.id === "mark-percent") {
    const parsed = parsePercent(target.value);
    if (!parsed.ok) {
      showToast("Enter a percent from 0 to 100.");
      render();
      return;
    }
    const record = ensureMark(course, target.dataset.student);
    record.percent = parsed.value;
    if (parsed.value != null) record.level = levelFromPercent(parsed.value).id;
    persist();
    render();
    return;
  }
  if (target.id === "mark-comment") {
    ensureMark(course, target.dataset.student).comment = target.value;
    persist();
    warnIfGoogleMissing();
  }
}

function onInput(event) {
  const target = event.target;
  if (target.id === "percent-slider") {
    const readout = document.getElementById("percent-readout");
    if (readout) readout.textContent = `${Math.round(Number(target.value))}%`;
    return;
  }
  if (target.id === "weekly-target") {
    const readout = document.getElementById("weekly-target-value");
    if (readout) readout.textContent = String(Math.round(Number(target.value)));
    return;
  }
  if (target.id === "code-search") {
    ui.codeQuery = target.value;
    const select = document.getElementById("course-code");
    if (!select) return;
    const selected = select.value;
    const matches = searchOntarioCourses(ui.codeQuery);
    const options = [];
    if (selected && !matches.some((item) => item.code === selected)) {
      const current = findOntarioCourse(selected);
      options.push(current || { code: selected, title: "Saved code" });
    }
    options.push(...matches);
    select.innerHTML = `<option value="">Choose A Course</option>${options
      .map((item) => `<option value="${esc(item.code)}">${esc(item.code)} — ${esc(item.title)}</option>`)
      .join("")}`;
    select.value = [...select.options].some((option) => option.value === selected) ? selected : "";
    return;
  }
  if (target.id === "student-list") {
    const courseId = parseRoute().courseId;
    if (courseId) ui.studentDraft[courseId] = target.value;
    return;
  }
  if (target.id === "roster-search") {
    ui.search = target.value;
    render();
    return;
  }
  if (target.id === "class-custom-expectation") {
    const courseId = parseRoute().courseId;
    if (courseId) classDraft(courseId).text = target.value;
    return;
  }
  if (!ui.capture) return;
  if (target.id === "entry-note") ui.capture.note = target.value;
  if (target.id === "custom-expectation") {
    ui.capture.customText = target.value;
    syncSlider();
  }
}

async function onImport(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const trimmed = text.trim();
    const parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : stateFromCsv(trimmed);
    if (!parsed || !Array.isArray(parsed.courses) || !parsed.courses.length) throw new Error("missing");
    const incoming = normalizeState(parsed).courses;
    const label = incoming.length === 1 ? (incoming[0].code || incoming[0].name || "this class") : `${incoming.length} classes`;
    const ok = await confirmAction(`Update ${label} from this file? Other classes on this device stay.`, "Import");
    if (!ok) return;
    const order = db.courses.map((course) => course.id);
    const merged = new Map(db.courses.map((course) => [course.id, course]));
    for (const course of incoming) {
      merged.set(course.id, course);
      if (!order.includes(course.id)) order.push(course.id);
    }
    const email = db.backupEmail;
    db = normalizeState({ ...db, courses: order.map((id) => merged.get(id)) });
    if (!db.backupEmail) db.backupEmail = email;
    persist();
    location.hash = db.lastCourseId ? hrefFor(db.lastCourseId, keptTab) : "#/";
    showToast("Backup imported.");
    render();
  } catch {
    showToast("That file is not a Class Record CSV.");
  }
}

function onPointerDown(event) {
  if (event.button != null && event.button !== 0) return;
  const load = event.target.closest?.("[data-action='reload-expectations'], [data-action='load-learning-skills']");
  if (load) {
    loadingExpectations = true;
    loadCourseCode = codeFromCourseSelect();
    return;
  }
  loadingExpectations = false;
  const tile = event.target.closest(".floor .tile[data-student]");
  if (!tile) return;
  drag = { id: tile.dataset.student, pointerId: event.pointerId, moved: false, x: event.clientX, y: event.clientY };
}

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const tile = appEl.querySelector(`.floor .tile[data-student="${CSS.escape(drag.id)}"]`);
  if (!tile) return;
  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    drag.moved = true;
    try {
      tile.setPointerCapture(event.pointerId);
    } catch {
      /* The pointer is already active for a real drag. */
    }
  }
  tile.classList.add("is-dragging");
  const previous = tile.style.pointerEvents;
  tile.style.pointerEvents = "none";
  const under = document.elementFromPoint(event.clientX, event.clientY)?.closest(".floor .tile");
  tile.style.pointerEvents = previous;
  if (!under || under === tile || under.parentElement !== tile.parentElement) return;
  if ([...tile.parentElement.children].indexOf(tile) < [...tile.parentElement.children].indexOf(under)) under.after(tile);
  else under.before(tile);
}

function onPointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const moved = drag.moved;
  drag = null;
  if (!moved) return;
  ignoreClick = true;
  setTimeout(() => {
    ignoreClick = false;
  }, 0);
  const route = parseRoute();
  const course = courseById(route.courseId);
  const floor = appEl.querySelector(".floor");
  if (!course || !floor) return;
  [...floor.children].forEach((item, index) => {
    const id = item.dataset.student;
    if (!id) return;
    const student = studentById(course, id);
    if (student) student.seat = index;
  });
  persist();
  render();
}

function onFocusOut(event) {
  const target = event.target;
  if (target?.id !== "student-list") return;
  if (event.relatedTarget?.closest?.("[data-action='save-student-list']")) return;
  const course = courseById(parseRoute().courseId);
  if (!course) return;
  ui.studentDraft[course.id] = target.value;
  syncStudentList(course, target.value, { render: false });
}

function start() {
  const saved = loadState();
  db = saved || emptyState();
  if (!saved) persist();
  appEl.addEventListener("click", onClick);
  appEl.addEventListener("submit", onSubmit);
  appEl.addEventListener("change", onChange);
  appEl.addEventListener("input", onInput);
  appEl.addEventListener("focusout", onFocusOut);
  appEl.addEventListener("pointerdown", onPointerDown);
  appEl.addEventListener("pointermove", onPointerMove);
  appEl.addEventListener("pointerup", onPointerUp);
  appEl.addEventListener("pointercancel", onPointerUp);
  importEl.addEventListener("change", onImport);
  window.addEventListener("hashchange", () => render());
  window.addEventListener("resize", () => requestAnimationFrame(fitSeatTiles));
  if (!location.hash) location.hash = db.lastCourseId ? hrefFor(db.lastCourseId) : "#/";
  else render();
  resumeGoogle();
}

async function resumeGoogle() {
  const picked = takePickedFolder();
  if (picked?.folder) rememberFolder(picked.folder);
  const result = await takeGoogleResult();
  if (result?.email) sessionStorage.setItem("class-record-google-account", googleEmail(result.email) || result.email);
  if (result?.error) showToast(result.error);
  refreshGoogleFields();
  const wantsSave = sessionStorage.getItem("class-record-google-save") === "1";
  if (wantsSave) sessionStorage.removeItem("class-record-google-save");
  const token = storedGoogleToken();
  const folder = storedFolder();
  if (wantsSave && !result?.error && folder && token?.token && canListDrive(token.scope)) {
    try {
      const names = await saveClassesToFolder(token.token, folder.id);
      noteDriveSync();
      showToast(savedClassMessage(names, folder.name));
    } catch (error) {
      showToast(error.message || "The backup could not be saved.");
    }
  } else if (!result?.error && result?.pending === "folder" && canListDrive(result.token?.scope)) {
    openDriveBrowser();
  }
}

start();
