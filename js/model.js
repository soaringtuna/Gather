export const LEVELS = [
  { id: "4", name: "Level 4", short: "4", min: 80, max: 100, midpoint: 90, band: "80–100%" },
  { id: "3", name: "Level 3", short: "3", min: 70, max: 79, midpoint: 75, band: "70–79%" },
  { id: "2", name: "Level 2", short: "2", min: 60, max: 69, midpoint: 65, band: "60–69%" },
  { id: "1", name: "Level 1", short: "1", min: 50, max: 59, midpoint: 55, band: "50–59%" },
  { id: "0", name: "Below Level 1", short: "Below", min: 0, max: 49, midpoint: 40, band: "Under 50%" },
];

export const KINDS = [
  { id: "conversation", label: "Conversation", chip: "Talk" },
  { id: "observation", label: "Observation", chip: "Saw" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function uid(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function formatDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[month - 1]} ${day}`;
}

export function levelById(id) {
  return LEVELS.find((level) => level.id === String(id)) || null;
}

export function levelFromPercent(percent) {
  const value = Number(percent);
  if (value >= 80) return levelById("4");
  if (value >= 70) return levelById("3");
  if (value >= 60) return levelById("2");
  if (value >= 50) return levelById("1");
  return levelById("0");
}

export function kindById(id) {
  return KINDS.find((kind) => kind.id === id) || KINDS[0];
}

export function studentName(student) {
  const first = (student?.preferredName || student?.firstName || "").trim();
  const last = (student?.lastName || "").trim();
  return `${first} ${last}`.trim() || "Student";
}

export function studentSortKey(student) {
  return `${student.lastName || ""} ${student.preferredName || student.firstName || ""}`.trim().toLowerCase();
}

export function initials(student) {
  const first = (student.preferredName || student.firstName || "?").trim();
  const last = (student.lastName || "").trim();
  return `${first.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

export function buttonLabel(text) {
  const clean = String(text || "").trim().replace(/\s+/g, " ");
  if (clean.length <= 40) return clean;
  return `${clean.slice(0, 38).trim()}…`;
}

export function defaultExpectations() {
  return [
    { id: uid("exp"), label: "Understanding", detail: "Show understanding of the learning you are checking." },
    { id: uid("exp"), label: "Thinking", detail: "Use a thinking skill tied to this expectation." },
    { id: uid("exp"), label: "Communication", detail: "Communicate the learning clearly." },
    { id: uid("exp"), label: "Application", detail: "Apply the learning in the task." },
  ];
}

export function parseExpectationLine(line) {
  const cleaned = line.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+[—–]\s+|\s+-\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { label: buttonLabel(parts[0]), detail: parts.slice(1).join(" — ") };
  }
  return { label: buttonLabel(cleaned), detail: cleaned };
}

export function parseStudentLine(line) {
  const cleaned = line.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  const parts = cleaned.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function isBehaviourEntry(entry) {
  return entry?.record === "behaviour";
}

export function entriesForStudent(course, studentId) {
  return course.entries
    .filter((entry) => entry.studentId === studentId)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function groupEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.expectationId || `custom:${entry.expectationLabel}`;
    if (!grouped.has(key)) grouped.set(key, { label: entry.expectationLabel, count: 0, levels: [] });
    const bucket = grouped.get(key);
    bucket.count += 1;
    bucket.levels.push(entry.level);
    bucket.label = entry.expectationLabel || bucket.label;
  }
  return [...grouped.values()];
}

export function summarizeStudent(course, student) {
  const entries = entriesForStudent(course, student.id);
  const assessment = entries.filter((entry) => !isBehaviourEntry(entry));
  const behaviour = entries.filter((entry) => isBehaviourEntry(entry));
  const byLevel = { 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
  const counts = { conversation: 0, observation: 0 };
  for (const entry of assessment) {
    if (byLevel[entry.level] != null) byLevel[entry.level] += 1;
    if (counts[entry.kind] != null) counts[entry.kind] += 1;
  }
  return {
    entries,
    assessment,
    behaviour,
    byLevel,
    counts,
    expectations: groupEntries(assessment),
    behaviours: groupEntries(behaviour),
    mark: course.marks?.[student.id] || null,
  };
}

export function parsePercent(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, value: null };
  return { ok: true, value: Math.round(value) };
}
