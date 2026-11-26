const COLUMNS = [
  "type",
  "courseId",
  "code",
  "name",
  "grade",
  "gradeLabel",
  "semester",
  "period",
  "sample",
  "seatColumns",
  "seatRows",
  "weeklyTarget",
  "weekStart",
  "studentId",
  "firstName",
  "lastName",
  "preferredName",
  "seat",
  "expectationId",
  "expectationLabel",
  "expectationDetail",
  "sessionId",
  "date",
  "topic",
  "entryId",
  "kind",
  "level",
  "percent",
  "note",
  "photo",
  "createdAt",
  "markLevel",
  "markPercent",
  "markComment",
  "markLevelValue",
  "checkpointId",
  "checkpointName",
  "checkpointDate",
  "checkpointAverage",
  "checkpointLevel",
  "checkpointPercent",
  "checkpointNote",
  "checkpointCount",
  "expectationsManaged",
  "expectationGroup",
  "curriculumCitation",
  "record",
  "audio",
];

function cell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function row(record) {
  return COLUMNS.map((key) => cell(record[key])).join(",");
}

function filePart(value) {
  return String(value || "")
    .replace(/[–—]/g, "-")
    .replace(/[,]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classCsvName(course) {
  const code = filePart(course?.code) || "Class";
  const semester = filePart(course?.semesterLabel) || "Semester not set";
  const period = course?.period ? `Period ${filePart(course.period)}` : "Period not set";
  return `${code} ${semester} ${period}.csv`.slice(0, 180);
}

export function courseToCsv(course) {
  return stateToCsv({ courses: [course] });
}

export function stateToCsv(state) {
  const lines = [COLUMNS.join(",")];
  for (const course of state.courses || []) {
    lines.push(row({
      type: "course",
      courseId: course.id,
      code: course.code,
      name: course.name,
      grade: course.grade,
      gradeLabel: course.gradeLabel || "",
      semester: course.semesterLabel || "",
      period: course.period || "",
      sample: course.sample ? "1" : "",
      seatColumns: course.seatColumns || 4,
      seatRows: course.seatRows || "",
      weeklyTarget: course.weeklyTarget || "",
      weekStart: course.weekStart || "",
      expectationsManaged: course.expectationsManaged ? "1" : "",
      curriculumCitation: course.curriculumCitation || "",
    }));
    for (const student of course.students || []) {
      lines.push(row({
        type: "student",
        courseId: course.id,
        studentId: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        preferredName: student.preferredName,
        seat: student.seat,
      }));
    }
    for (const item of course.expectations || []) {
      lines.push(row({
        type: "expectation",
        courseId: course.id,
        expectationId: item.id,
        expectationLabel: item.label,
        expectationDetail: item.detail,
        expectationGroup: item.group || "",
      }));
    }
    for (const item of course.behaviourExpectations || []) {
      lines.push(row({
        type: "behaviour",
        courseId: course.id,
        expectationId: item.id,
        expectationLabel: item.label,
        expectationDetail: item.detail,
        expectationGroup: item.group || "",
      }));
    }
    for (const session of course.sessions || []) {
      lines.push(row({
        type: "session",
        courseId: course.id,
        sessionId: session.id,
        date: session.date,
        topic: session.topic || "",
      }));
    }
    for (const entry of course.entries || []) {
      lines.push(row({
        type: "entry",
        courseId: course.id,
        sessionId: entry.sessionId,
        date: entry.date,
        studentId: entry.studentId,
        expectationId: entry.expectationId || "",
        expectationLabel: entry.expectationLabel,
        entryId: entry.id,
        kind: entry.kind,
        record: entry.record === "behaviour" ? "behaviour" : "assessment",
        level: entry.level,
        percent: entry.percent,
        note: entry.note || "",
        photo: entry.photo || "",
        audio: entry.audio || "",
        createdAt: entry.createdAt || "",
      }));
    }
    for (const entryId of course.deletedEntryIds || []) {
      lines.push(row({
        type: "removed-entry",
        courseId: course.id,
        entryId,
      }));
    }
    for (const [studentId, mark] of Object.entries(course.marks || {})) {
      lines.push(row({
        type: "mark",
        courseId: course.id,
        studentId,
        markLevel: mark?.level || "",
        markPercent: mark?.percent ?? "",
        markComment: mark?.comment || "",
        markLevelValue: mark?.levelValue ?? "",
      }));
      for (const checkpoint of mark?.checkpoints || []) {
        lines.push(row({
          type: "checkpoint",
          courseId: course.id,
          studentId,
          checkpointId: checkpoint.id,
          checkpointName: checkpoint.name,
          checkpointDate: checkpoint.date,
          checkpointAverage: checkpoint.average ?? "",
          checkpointLevel: checkpoint.levelValue ?? "",
          checkpointPercent: checkpoint.percent ?? "",
          checkpointNote: checkpoint.note || "",
          checkpointCount: checkpoint.count ?? "",
          createdAt: checkpoint.createdAt || "",
        }));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value !== ""));
}

export function stateFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("empty");
  const header = rows[0].map((item) => item.trim());
  if (header[0] !== "type" || !header.includes("courseId")) throw new Error("header");
  const index = new Map(header.map((key, position) => [key, position]));
  const value = (record, key) => {
    const position = index.get(key);
    return position == null ? "" : record[position] || "";
  };
  const courses = new Map();
  const ensure = (courseId) => {
    if (!courses.has(courseId)) {
      courses.set(courseId, {
        id: courseId,
        name: "Untitled course",
        code: "",
        grade: 10,
        semesterLabel: "",
        period: "",
        sample: false,
        seatColumns: 4,
        seatRows: "",
        weeklyTarget: "",
        weekStart: "",
        students: [],
        expectations: [],
        behaviourExpectations: [],
        sessions: [],
        entries: [],
        deletedEntryIds: [],
        marks: {},
      });
    }
    return courses.get(courseId);
  };
  for (const record of rows.slice(1)) {
    const type = value(record, "type");
    const courseId = value(record, "courseId");
    if (!courseId) continue;
    const course = ensure(courseId);
    if (type === "course") {
      course.name = value(record, "name") || course.name;
      course.code = value(record, "code");
      course.grade = Number(value(record, "grade")) || 10;
      course.gradeLabel = value(record, "gradeLabel");
      course.semesterLabel = value(record, "semester");
      course.period = value(record, "period");
      course.sample = value(record, "sample") === "1";
      course.seatColumns = Number(value(record, "seatColumns")) || 4;
      course.seatRows = Number(value(record, "seatRows")) || "";
      course.weeklyTarget = Number(value(record, "weeklyTarget")) || 0;
      course.weekStart = value(record, "weekStart");
      course.expectationsManaged = value(record, "expectationsManaged") === "1";
      course.curriculumCitation = value(record, "curriculumCitation");
    } else if (type === "student") {
      course.students.push({
        id: value(record, "studentId"),
        firstName: value(record, "firstName"),
        lastName: value(record, "lastName"),
        preferredName: value(record, "preferredName"),
        seat: Number(value(record, "seat")),
      });
    } else if (type === "expectation") {
      course.expectations.push({
        id: value(record, "expectationId"),
        label: value(record, "expectationLabel"),
        detail: value(record, "expectationDetail"),
        group: value(record, "expectationGroup"),
      });
    } else if (type === "behaviour") {
      course.behaviourExpectations.push({
        id: value(record, "expectationId"),
        label: value(record, "expectationLabel"),
        detail: value(record, "expectationDetail"),
        group: value(record, "expectationGroup"),
      });
    } else if (type === "session") {
      course.sessions.push({
        id: value(record, "sessionId"),
        date: value(record, "date"),
        topic: value(record, "topic"),
      });
    } else if (type === "entry") {
      course.entries.push({
        id: value(record, "entryId"),
        sessionId: value(record, "sessionId"),
        date: value(record, "date"),
        studentId: value(record, "studentId"),
        kind: value(record, "kind"),
        record: value(record, "record") === "behaviour" ? "behaviour" : "assessment",
        expectationId: value(record, "expectationId") || null,
        expectationLabel: value(record, "expectationLabel"),
        level: value(record, "level"),
        percent: Number(value(record, "percent")),
        note: value(record, "note"),
        photo: value(record, "photo"),
        audio: value(record, "audio"),
        createdAt: value(record, "createdAt"),
      });
    } else if (type === "removed-entry") {
      const entryId = value(record, "entryId");
      if (entryId) course.deletedEntryIds.push(entryId);
    } else if (type === "mark") {
      const studentId = value(record, "studentId");
      const percent = value(record, "markPercent");
      const levelValue = value(record, "markLevelValue");
      const existing = course.marks[studentId]?.checkpoints || [];
      course.marks[studentId] = {
        level: value(record, "markLevel") || null,
        percent: percent === "" ? null : Number(percent),
        comment: value(record, "markComment"),
        levelValue: levelValue === "" ? undefined : Number(levelValue),
        checkpoints: existing,
      };
    } else if (type === "checkpoint") {
      const studentId = value(record, "studentId");
      if (!course.marks[studentId]) course.marks[studentId] = { level: null, percent: null, comment: "", checkpoints: [] };
      if (!course.marks[studentId].checkpoints) course.marks[studentId].checkpoints = [];
      const average = value(record, "checkpointAverage");
      const levelValue = value(record, "checkpointLevel");
      const percent = value(record, "checkpointPercent");
      course.marks[studentId].checkpoints.push({
        id: value(record, "checkpointId"),
        name: value(record, "checkpointName"),
        date: value(record, "checkpointDate"),
        average: average === "" ? null : Number(average),
        levelValue: levelValue === "" ? null : Number(levelValue),
        percent: percent === "" ? null : Number(percent),
        note: value(record, "checkpointNote"),
        count: Number(value(record, "checkpointCount")) || 0,
        createdAt: value(record, "createdAt"),
      });
    }
  }
  for (const course of courses.values()) {
    const removed = new Set(course.deletedEntryIds);
    course.deletedEntryIds = [...removed];
    course.entries = course.entries.filter((entry) => entry.id && !removed.has(entry.id));
  }
  return { courses: [...courses.values()] };
}

function textKey(value) {
  return String(value || "").trim().toLowerCase();
}

function classKey(course) {
  const code = textKey(course?.code);
  if (!code) return "";
  return `${code}|${textKey(course.period)}|${textKey(course.semesterLabel)}`;
}

function studentKey(student) {
  return textKey(`${student?.firstName || ""} ${student?.lastName || ""}`);
}

function copyList(list) {
  return (Array.isArray(list) ? list : []).map((item) => ({ ...item }));
}

function remap(value, map) {
  if (!value) return value || "";
  return map.get(value) || value;
}

function mergeStudents(localStudents, remoteStudents) {
  const students = copyList(localStudents);
  const idMap = new Map();
  for (const remote of remoteStudents || []) {
    const key = studentKey(remote);
    const existing = students.find((student) => remote.id && student.id === remote.id)
      || (key ? students.find((student) => studentKey(student) === key) : null);
    if (existing) {
      if (remote.id) idMap.set(remote.id, existing.id);
      if (!existing.preferredName && remote.preferredName) existing.preferredName = remote.preferredName;
      continue;
    }
    const added = { ...remote };
    students.push(added);
    if (remote.id || added.id) idMap.set(remote.id || added.id, added.id || remote.id);
  }
  return { students, idMap };
}

function mergeNamedItems(localItems, remoteItems) {
  const items = copyList(localItems);
  const idMap = new Map();
  for (const remote of remoteItems || []) {
    const label = textKey(remote.label);
    const existing = items.find((item) => remote.id && item.id === remote.id)
      || (label ? items.find((item) => textKey(item.label) === label) : null);
    if (existing) {
      if (remote.id) idMap.set(remote.id, existing.id);
      if (!existing.detail && remote.detail) existing.detail = remote.detail;
      if (!existing.group && remote.group) existing.group = remote.group;
      continue;
    }
    items.push({ ...remote });
    if (remote.id) idMap.set(remote.id, remote.id);
  }
  return { items, idMap };
}

function mergeSessions(localSessions, remoteSessions) {
  const sessions = copyList(localSessions);
  const idMap = new Map();
  for (const remote of remoteSessions || []) {
    const key = `${remote.date || ""}|${textKey(remote.topic)}`;
    const existing = sessions.find((session) => remote.id && session.id === remote.id)
      || (key !== "|" ? sessions.find((session) => `${session.date || ""}|${textKey(session.topic)}` === key) : null);
    if (existing) {
      if (remote.id) idMap.set(remote.id, existing.id);
      if (!existing.topic && remote.topic) existing.topic = remote.topic;
      continue;
    }
    sessions.push({ ...remote });
    if (remote.id) idMap.set(remote.id, remote.id);
  }
  return { sessions, idMap };
}

function entryScore(entry) {
  return String(entry?.note || "").length + (entry?.photo ? 100000 : 0) + (entry?.audio ? 100000 : 0);
}

function mergeEntry(local, remote) {
  const primary = entryScore(remote) > entryScore(local) ? remote : local;
  const other = primary === remote ? local : remote;
  return {
    ...primary,
    note: primary.note || other.note || "",
    photo: primary.photo || other.photo || "",
    audio: primary.audio || other.audio || "",
  };
}

function mergeMarks(localMarks, remoteMarks, studentMap) {
  const marks = {};
  for (const [studentId, mark] of Object.entries(localMarks || {})) {
    marks[studentId] = { ...mark, checkpoints: copyList(mark?.checkpoints) };
  }
  for (const [studentId, mark] of Object.entries(remoteMarks || {})) {
    const id = remap(studentId, studentMap);
    const local = marks[id];
    if (!local) {
      marks[id] = { ...mark, checkpoints: copyList(mark?.checkpoints) };
      continue;
    }
    if (!local.level && mark?.level) local.level = mark.level;
    if ((local.percent == null || local.percent === "") && mark?.percent != null && mark.percent !== "") local.percent = mark.percent;
    if (!local.comment && mark?.comment) local.comment = mark.comment;
    if (local.levelValue == null && mark?.levelValue != null) local.levelValue = mark.levelValue;
    const seen = new Set((local.checkpoints || []).map((item) => item.id).filter(Boolean));
    for (const checkpoint of mark?.checkpoints || []) {
      if (checkpoint.id && seen.has(checkpoint.id)) {
        const existing = local.checkpoints.find((item) => item.id === checkpoint.id);
        if (existing && !existing.note && checkpoint.note) existing.note = checkpoint.note;
        continue;
      }
      local.checkpoints.push({ ...checkpoint });
      if (checkpoint.id) seen.add(checkpoint.id);
    }
  }
  return marks;
}

function mergeCourse(local, remote) {
  const students = mergeStudents(local.students, remote.students);
  const expectations = mergeNamedItems(local.expectations, remote.expectations);
  const behaviour = mergeNamedItems(local.behaviourExpectations, remote.behaviourExpectations);
  const sessions = mergeSessions(local.sessions, remote.sessions);
  const expectationMap = new Map([...expectations.idMap, ...behaviour.idMap]);
  const removed = new Set([...(local.deletedEntryIds || []), ...(remote.deletedEntryIds || [])]);
  const entries = copyList(local.entries).filter((entry) => entry.id && !removed.has(entry.id));
  const seen = new Map(entries.map((entry) => [entry.id, entry]));
  for (const remoteEntry of remote.entries || []) {
    if (!remoteEntry.id || removed.has(remoteEntry.id)) continue;
    const entry = {
      ...remoteEntry,
      studentId: remap(remoteEntry.studentId, students.idMap),
      expectationId: remap(remoteEntry.expectationId, expectationMap) || null,
      sessionId: remap(remoteEntry.sessionId, sessions.idMap),
    };
    const existing = seen.get(entry.id);
    if (!existing) {
      entries.push(entry);
      seen.set(entry.id, entry);
      continue;
    }
    const merged = mergeEntry(existing, entry);
    merged.studentId = existing.studentId || entry.studentId;
    Object.assign(existing, merged);
  }
  return {
    ...local,
    gradeLabel: local.gradeLabel || remote.gradeLabel || "",
    curriculumCitation: local.curriculumCitation || remote.curriculumCitation || "",
    expectationsManaged: Boolean(local.expectationsManaged || remote.expectationsManaged),
    students: students.students,
    expectations: expectations.items,
    behaviourExpectations: behaviour.items,
    sessions: sessions.sessions,
    entries,
    deletedEntryIds: [...removed],
    marks: mergeMarks(local.marks, remote.marks, students.idMap),
  };
}

function pairedRemote(localCourses, remoteCourses) {
  const used = new Set();
  const pairs = (localCourses || []).map((course) => {
    const remote = (remoteCourses || []).find((item) => item.id && item.id === course.id && !used.has(item))
      || (remoteCourses || []).find((item) => {
        const key = classKey(item);
        return key && key === classKey(course) && !used.has(item);
      });
    if (remote) used.add(remote);
    return { course, remote };
  });
  const extra = (remoteCourses || []).filter((item) => !used.has(item));
  return { pairs, extra };
}

export function coursesOnlyInFolder(localCourses, remoteCourses) {
  return pairedRemote(localCourses, remoteCourses).extra;
}

export function mergeCourses(localCourses, remoteCourses, { includeNew = true } = {}) {
  const { pairs, extra } = pairedRemote(localCourses, remoteCourses);
  const merged = pairs.map(({ course, remote }) => (remote ? mergeCourse(course, remote) : course));
  if (includeNew) merged.push(...extra);
  return merged;
}
