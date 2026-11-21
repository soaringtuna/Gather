import { defaultExpectations, uid } from "./model.js";

const KEY = "participation-record-v1";

function normalizeStudent(raw, index) {
  const seat = Number(raw?.seat);
  return {
    id: String(raw?.id || uid("stu")),
    firstName: String(raw?.firstName || "").trim(),
    lastName: String(raw?.lastName || "").trim(),
    preferredName: String(raw?.preferredName || "").trim(),
    seat: Number.isInteger(seat) && seat >= 0 ? seat : index,
  };
}

function normalizeExpectation(raw) {
  const detail = String(raw?.detail || raw?.label || "").trim();
  const label = String(raw?.label || detail).trim();
  if (!label && !detail) return null;
  return { id: String(raw?.id || uid("exp")), label: label || detail, detail: detail || label, group: String(raw?.group || "") };
}

function normalizeEntry(raw) {
  const level = String(raw?.level ?? "");
  if (!raw?.studentId || !["conversation", "observation"].includes(raw.kind)) return null;
  if (!["4", "3", "2", "1", "0"].includes(level)) return null;
  const percent = Number(raw.percent);
  return {
    id: String(raw.id || uid("ev")),
    sessionId: String(raw.sessionId || ""),
    date: String(raw.date || ""),
    studentId: String(raw.studentId),
    kind: raw.kind,
    record: raw.record === "behaviour" ? "behaviour" : "assessment",
    expectationId: raw.expectationId ? String(raw.expectationId) : null,
    expectationLabel: String(raw.expectationLabel || "Expectation"),
    level,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
    note: String(raw.note || ""),
    photo: String(raw.photo || "").startsWith("data:image/") ? String(raw.photo) : "",
    createdAt: String(raw.createdAt || new Date().toISOString()),
  };
}

export function normalizeCourse(raw) {
  const grade = Number(raw?.grade);
  const columns = Number(raw?.seatColumns);
  const expectations = Array.isArray(raw?.expectations)
    ? raw.expectations.map(normalizeExpectation).filter(Boolean)
    : defaultExpectations();
  const students = (Array.isArray(raw?.students) ? raw.students : [])
    .map((student, index) => normalizeStudent(student, index))
    .filter((student) => student.firstName || student.lastName)
    .sort((a, b) => a.seat - b.seat || String(a.lastName).localeCompare(String(b.lastName)));
  const usedSeats = new Set();
  for (const student of students) {
    let seat = student.seat;
    if (!Number.isInteger(seat) || seat < 0 || usedSeats.has(seat)) {
      seat = 0;
      while (usedSeats.has(seat)) seat += 1;
    }
    student.seat = seat;
    usedSeats.add(seat);
  }
  return {
    id: String(raw?.id || uid("course")),
    name: String(raw?.name || "Untitled course").trim() || "Untitled course",
    code: String(raw?.code || "").trim().toUpperCase(),
    grade: [9, 10, 11, 12].includes(grade) ? grade : 10,
    gradeLabel: String(raw?.gradeLabel || "").trim(),
    semesterLabel: String(raw?.semesterLabel || "").trim(),
    period: ["1", "2", "3", "4", "5"].includes(String(raw?.period || "")) ? String(raw.period) : "",
    sample: Boolean(raw?.sample),
    seatColumns: columns >= 2 && columns <= 8 ? columns : 4,
    seatRows: Number(raw?.seatRows) >= 1 && Number(raw?.seatRows) <= 8 ? Math.round(Number(raw.seatRows)) : Math.max(1, Math.min(8, Math.ceil(students.length / (columns >= 2 && columns <= 8 ? columns : 4)) || 1)),
    weeklyTarget: Number.isInteger(Number(raw?.weeklyTarget)) && Number(raw.weeklyTarget) >= 0 && Number(raw.weeklyTarget) <= 10 ? Number(raw.weeklyTarget) : 0,
    weekStart: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.weekStart || "")) ? String(raw.weekStart) : "",
    students,
    expectations,
    behaviourExpectations: Array.isArray(raw?.behaviourExpectations) ? raw.behaviourExpectations.map(normalizeExpectation).filter(Boolean) : [],
    expectationsManaged: Boolean(raw?.expectationsManaged),
    curriculumCitation: String(raw?.curriculumCitation || "").trim().slice(0, 400),
    sessions: Array.isArray(raw?.sessions) ? raw.sessions : [],
    entries: (Array.isArray(raw?.entries) ? raw.entries : []).map(normalizeEntry).filter(Boolean),
    marks: raw?.marks && typeof raw.marks === "object" ? raw.marks : {},
  };
}

export function normalizeState(raw) {
  const courses = (Array.isArray(raw?.courses) ? raw.courses : []).map(normalizeCourse);
  const lastCourseId = courses.some((course) => course.id === raw?.lastCourseId) ? raw.lastCourseId : courses[0]?.id || null;
  return { version: 3, lastCourseId, backupEmail: String(raw?.backupEmail || "").trim(), courses };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.courses)) return null;
    return normalizeState(parsed);
  } catch {
    return null;
  }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function emptyState() {
  return { version: 3, lastCourseId: null, backupEmail: "", courses: [] };
}
