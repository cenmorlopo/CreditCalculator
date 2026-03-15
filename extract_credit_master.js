const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const FILES = {
  input: path.join(__dirname, "branch_probe_input.txt"),
  raw: path.join(__dirname, "credit_raw.txt"),
  master: path.join(__dirname, "credit_master.txt"),
  duplicates: path.join(__dirname, "credit_duplicates.txt"),
  mismatches: path.join(__dirname, "credit_mismatches.txt"),
  totals: path.join(__dirname, "credit_totals.txt"),
  totalMismatches: path.join(__dirname, "credit_total_mismatches.txt"),
  failed: path.join(__dirname, "credit_failed.txt"),
  log: path.join(__dirname, "credit_log.txt"),
  state: path.join(__dirname, "credit_state.json"),
  seen: path.join(__dirname, "credit_seen.txt")
};

const CONFIG = {
  timeoutMs: 25000,
  maxRetries: 3,
  retryDelayMs: 1200,
  politeDelayMs: 700,
  maxRuntimeMs: 5 * 60 * 60 * 1000
};

// Credit extraction mappings
// 22 batch => 1st sem result published in 2022, 2nd sem result published in 2023
// 23 batch => 1st sem result published in 2023, 2nd sem result published in 2024
const URLS = {
  "22": {
    I: "http://results.beup.ac.in/ResultsBTech1stSem2022_B2022Pub.aspx",
    II: "http://results.beup.ac.in/ResultsBTech2ndSem2023_B2022Pub.aspx"
  },
  "23": {
    I: "http://results.beup.ac.in/ResultsBTech1stSem2023_B2023Pub.aspx",
    II: "http://results.beup.ac.in/ResultsBTech2ndSem2024_B2023Pub.aspx"
  },
  "24": {
    I: "http://results.beup.ac.in/ResultsBTech1stSem2024_B2024Pub.aspx"
  }
};

function ensureFile(filePath, defaultContent = "") {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + "\n", "utf8");
}

function normalize(v) {
  return String(v || "").trim();
}

function parseRegNo(regNo) {
  const r = normalize(regNo);
  return {
    reg_no: r,
    admission_year: r.slice(0, 2),
    branch_code_from_reg: r.slice(2, 5),
    college_code: r.slice(5, 8),
    roll_no: r.slice(8)
  };
}

function buildUrl(regNo, sem) {
  const reg = parseRegNo(regNo);
  const batch = reg.admission_year;
  const semKey = normalize(sem).toUpperCase();
  const base = URLS[batch] && URLS[batch][semKey];
  if (!base) return null;
  return `${base}?Sem=${semKey}&RegNo=${regNo}`;
}

function loadState() {
  ensureFile(FILES.state, JSON.stringify({ taskIndex: 0 }, null, 2));
  try {
    return JSON.parse(fs.readFileSync(FILES.state, "utf8"));
  } catch {
    return { taskIndex: 0 };
  }
}

function saveState(taskIndex) {
  fs.writeFileSync(
    FILES.state,
    JSON.stringify({ taskIndex, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function loadSet(filePath) {
  ensureFile(filePath, "");
  return new Set(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean)
  );
}

function appendUnique(filePath, setObj, value) {
  if (!setObj.has(value)) {
    fs.appendFileSync(filePath, value + "\n", "utf8");
    setObj.add(value);
  }
}

function loadInputRows() {
  if (!fs.existsSync(FILES.input)) {
    throw new Error(`Missing input file: ${FILES.input}`);
  }

  return fs.readFileSync(FILES.input, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith("#"))
    .map(line => {
      const parts = line.split("|").map(s => s.trim());
      if (parts.length < 3) return null;

      const reg_no = parts[0];
      const branch_code_input = parts[1];
      const branch_name_input = parts[2];
      const batch_input = parts[3] || parseRegNo(reg_no).admission_year;

      return {
        reg_no,
        branch_code_input,
        branch_name_input,
        batch_input
      };
    })
    .filter(Boolean);
}

function buildTasks(rows) {
  const tasks = [];
  for (const row of rows) {
    const batch = normalize(row.batch_input);
    const supported = URLS[batch] || {};
    for (const sem of ["I", "II"]) {
      if (supported[sem]) {
        tasks.push({ ...row, sem });
      }
    }
  }
  return tasks;
}

async function fetchWithRetries(url) {
  let delay = CONFIG.retryDelayMs;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: CONFIG.timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml"
        },
        validateStatus: status => status >= 200 && status < 400
      });

      if (
        response.status === 200 &&
        typeof response.data === "string" &&
        !response.data.includes("No Record Found !!!")
      ) {
        return { kind: "FOUND", html: response.data };
      }

      return { kind: "NO_RECORD" };
    } catch (error) {
      if (attempt === CONFIG.maxRetries) {
        return { kind: "ERROR", error: error.message };
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  return { kind: "ERROR", error: "Unknown fetch error" };
}

function parseHtml(html, task) {
  if (!html) return [];

  const $ = cheerio.load(html);
  const reg = parseRegNo(task.reg_no);

  const studentName = normalize($("#ContentPlaceHolder1_DataList1_StudentNameLabel_0").text());
  const courseName = normalize($("#ContentPlaceHolder1_DataList1_CourseLabel_0").text());

  const rows = [];

  $("#ContentPlaceHolder1_GridView1 tr").slice(1).each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length >= 7) {
      rows.push({
        sem: task.sem,
        reg_no: task.reg_no,
        batch: reg.admission_year,
        branch_code: task.branch_code_input,
        branch_code_from_reg: reg.branch_code_from_reg,
        branch_name: task.branch_name_input,
        subject_type: "theory",
        subject_code: normalize($(cells[0]).text()),
        subject_name: normalize($(cells[1]).text()),
        credit: normalize($(cells[6]).text()),
        student_name: studentName,
        course_name: courseName
      });
    }
  });

  $("#ContentPlaceHolder1_GridView2 tr").slice(1).each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length >= 7) {
      rows.push({
        sem: task.sem,
        reg_no: task.reg_no,
        batch: reg.admission_year,
        branch_code: task.branch_code_input,
        branch_code_from_reg: reg.branch_code_from_reg,
        branch_name: task.branch_name_input,
        subject_type: "practical",
        subject_code: normalize($(cells[0]).text()),
        subject_name: normalize($(cells[1]).text()),
        credit: normalize($(cells[6]).text()),
        student_name: studentName,
        course_name: courseName
      });
    }
  });

  return rows;
}

function initOutputs() {
  ensureFile(FILES.log, "");
  ensureFile(FILES.failed, "");
  ensureFile(FILES.seen, "");

  ensureFile(
    FILES.raw,
    "batch | sem | reg_no | branch_code | branch_name | subject_type | subject_code | subject_name | credit\n"
  );

  ensureFile(
    FILES.master,
    "sem | branch_code | branch_name | subject_code | credit | total_sem_credit | status | sample_reg_nos\n"
  );

  ensureFile(
    FILES.duplicates,
    "sem | branch_code | subject_code | credit | duplicate_reg_nos\n"
  );

  ensureFile(
    FILES.mismatches,
    "sem | branch_code | subject_code | issue | seen_values | sample_reg_nos\n"
  );

  ensureFile(
    FILES.totals,
    "sem | branch_code | branch_name | total_sem_credit | status | sample_reg_nos\n"
  );

  ensureFile(
    FILES.totalMismatches,
    "sem | branch_code | issue | seen_total_values | sample_reg_nos\n"
  );
}

function appendRawRows(rows) {
  const lines = rows.map(r =>
    [
      r.batch,
      r.sem,
      r.reg_no,
      r.branch_code,
      r.branch_name,
      r.subject_type,
      r.subject_code,
      r.subject_name,
      r.credit
    ].join(" | ")
  );
  fs.appendFileSync(FILES.raw, lines.join("\n") + "\n", "utf8");
}

function rebuildOutputsFromRaw() {
  const rawLines = fs.readFileSync(FILES.raw, "utf8")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(line => !/^batch\s*\|/i.test(line));

  const subjectGroupMap = new Map();
  const studentSemMap = new Map();

  for (const line of rawLines) {
    const p = line.split("|").map(x => x.trim());
    if (p.length < 9) continue;

    const batch = p[0];
    const sem = p[1];
    const reg_no = p[2];
    const branch_code = p[3];
    const branch_name = p[4];
    const subject_type = p[5];
    const subject_code = p[6];
    const subject_name = p[7];
    const credit = p[8];

    const subjectKey = `${sem}|${branch_code}|${subject_code}`;
    if (!subjectGroupMap.has(subjectKey)) {
      subjectGroupMap.set(subjectKey, {
        sem,
        branch_code,
        branch_names: new Set(),
        subject_code,
        subject_names: new Set(),
        subject_types: new Set(),
        credits: new Set(),
        reg_nos: new Set(),
        batches: new Set()
      });
    }

    const sg = subjectGroupMap.get(subjectKey);
    sg.branch_names.add(branch_name);
    sg.subject_names.add(subject_name);
    sg.subject_types.add(subject_type);
    sg.credits.add(credit);
    sg.reg_nos.add(reg_no);
    sg.batches.add(batch);

    const studentSemKey = `${sem}|${branch_code}|${reg_no}`;
    if (!studentSemMap.has(studentSemKey)) {
      studentSemMap.set(studentSemKey, {
        sem,
        branch_code,
        branch_name,
        reg_no,
        subjects: new Map()
      });
    }

    studentSemMap.get(studentSemKey).subjects.set(subject_code, {
      credit
    });
  }

  const totalGroupMap = new Map();

  for (const [, item] of studentSemMap) {
    let total = 0;
    for (const [, sub] of item.subjects) {
      const n = parseFloat(String(sub.credit).replace(/[^\d.]/g, ""));
      if (Number.isFinite(n)) total += n;
    }

    const totalKey = `${item.sem}|${item.branch_code}`;
    if (!totalGroupMap.has(totalKey)) {
      totalGroupMap.set(totalKey, {
        sem: item.sem,
        branch_code: item.branch_code,
        branch_name: item.branch_name,
        totals: new Set(),
        reg_nos: new Set()
      });
    }

    totalGroupMap.get(totalKey).totals.add(String(total));
    totalGroupMap.get(totalKey).reg_nos.add(item.reg_no);
  }

  const totalLookup = new Map();
  for (const [, tg] of totalGroupMap) {
    totalLookup.set(`${tg.sem}|${tg.branch_code}`, Array.from(tg.totals).sort());
  }

  const masterLines = [
    "sem | branch_code | branch_name | subject_code | credit | total_sem_credit | status | sample_reg_nos"
  ];

  const duplicateLines = [
    "sem | branch_code | subject_code | credit | duplicate_reg_nos"
  ];

  const mismatchLines = [
    "sem | branch_code | subject_code | issue | seen_values | sample_reg_nos"
  ];

  const totalLines = [
    "sem | branch_code | branch_name | total_sem_credit | status | sample_reg_nos"
  ];

  const totalMismatchLines = [
    "sem | branch_code | issue | seen_total_values | sample_reg_nos"
  ];

  const subjectKeys = Array.from(subjectGroupMap.keys()).sort();

  for (const key of subjectKeys) {
    const sg = subjectGroupMap.get(key);

    const branchNames = Array.from(sg.branch_names).sort();
    const subjectNames = Array.from(sg.subject_names).sort();
    const subjectTypes = Array.from(sg.subject_types).sort();
    const credits = Array.from(sg.credits).sort();
    const regs = Array.from(sg.reg_nos).sort();

    const totalSemCredit = (totalLookup.get(`${sg.sem}|${sg.branch_code}`) || []).join(",");
    let status = "MATCH";

    if (
      branchNames.length > 1 ||
      subjectNames.length > 1 ||
      subjectTypes.length > 1 ||
      credits.length > 1
    ) {
      status = "MISMATCH";
    } else if (regs.length > 1) {
      status = "DUPLICATE_SUPPORT";
    }

    masterLines.push([
      sg.sem,
      sg.branch_code,
      branchNames.join(" || "),
      sg.subject_code,
      credits.join(","),
      totalSemCredit,
      status,
      regs.join(",")
    ].join(" | "));

    if (regs.length > 1 && credits.length === 1 && subjectNames.length === 1 && subjectTypes.length === 1) {
      duplicateLines.push([
        sg.sem,
        sg.branch_code,
        sg.subject_code,
        credits[0],
        regs.join(",")
      ].join(" | "));
    }

    if (branchNames.length > 1) {
      mismatchLines.push([
        sg.sem,
        sg.branch_code,
        sg.subject_code,
        "BRANCH_NAME_MISMATCH",
        branchNames.join(" || "),
        regs.join(",")
      ].join(" | "));
    }

    if (subjectNames.length > 1) {
      mismatchLines.push([
        sg.sem,
        sg.branch_code,
        sg.subject_code,
        "SUBJECT_NAME_MISMATCH",
        subjectNames.join(" || "),
        regs.join(",")
      ].join(" | "));
    }

    if (subjectTypes.length > 1) {
      mismatchLines.push([
        sg.sem,
        sg.branch_code,
        sg.subject_code,
        "SUBJECT_TYPE_MISMATCH",
        subjectTypes.join(","),
        regs.join(",")
      ].join(" | "));
    }

    if (credits.length > 1) {
      mismatchLines.push([
        sg.sem,
        sg.branch_code,
        sg.subject_code,
        "CREDIT_MISMATCH",
        credits.join(","),
        regs.join(",")
      ].join(" | "));
    }
  }

  const totalKeys = Array.from(totalGroupMap.keys()).sort();

  for (const key of totalKeys) {
    const tg = totalGroupMap.get(key);
    const totals = Array.from(tg.totals).sort();
    const regs = Array.from(tg.reg_nos).sort();
    const status = totals.length === 1 ? "MATCH" : "MISMATCH";

    totalLines.push([
      tg.sem,
      tg.branch_code,
      tg.branch_name,
      totals.join(","),
      status,
      regs.join(",")
    ].join(" | "));

    if (totals.length > 1) {
      totalMismatchLines.push([
        tg.sem,
        tg.branch_code,
        "TOTAL_SEM_CREDIT_MISMATCH",
        totals.join(","),
        regs.join(",")
      ].join(" | "));
    }
  }

  fs.writeFileSync(FILES.master, masterLines.join("\n") + "\n", "utf8");
  fs.writeFileSync(FILES.duplicates, duplicateLines.join("\n") + "\n", "utf8");
  fs.writeFileSync(FILES.mismatches, mismatchLines.join("\n") + "\n", "utf8");
  fs.writeFileSync(FILES.totals, totalLines.join("\n") + "\n", "utf8");
  fs.writeFileSync(FILES.totalMismatches, totalMismatchLines.join("\n") + "\n", "utf8");
}

async function run() {
  initOutputs();

  const rows = loadInputRows();
  const tasks = buildTasks(rows);
  const state = loadState();
  const seen = loadSet(FILES.seen);

  const startedAt = Date.now();

  log(`Loaded ${rows.length} input rows`);
  log(`Built ${tasks.length} semester tasks`);
  log(`Resuming from taskIndex=${state.taskIndex}`);

  for (let i = state.taskIndex; i < tasks.length; i++) {
    if (Date.now() - startedAt > CONFIG.maxRuntimeMs) {
      log(`STOP max runtime reached`);
      saveState(i);
      rebuildOutputsFromRaw();
      return;
    }

    const task = tasks[i];
    const taskKey = `${task.reg_no}|${task.sem}`;
    const url = buildUrl(task.reg_no, task.sem);

    if (!url) {
      fs.appendFileSync(FILES.failed, `${taskKey} | UNSUPPORTED_URL_MAPPING\n`, "utf8");
      log(`[${i + 1}/${tasks.length}] ${taskKey} -> UNSUPPORTED_URL_MAPPING`);
      saveState(i + 1);
      continue;
    }

    if (seen.has(taskKey)) {
      log(`[${i + 1}/${tasks.length}] ${taskKey} -> DUP_ALREADY_PROCESSED`);
      saveState(i + 1);
      continue;
    }

    const fetched = await fetchWithRetries(url);

    if (fetched.kind === "ERROR") {
      fs.appendFileSync(FILES.failed, `${taskKey} | ERROR | ${fetched.error}\n`, "utf8");
      log(`[${i + 1}/${tasks.length}] ${taskKey} -> ERR -> ${fetched.error}`);
      saveState(i + 1);
      await sleep(CONFIG.politeDelayMs);
      continue;
    }

    if (fetched.kind === "NO_RECORD") {
      fs.appendFileSync(FILES.failed, `${taskKey} | NO_RECORD\n`, "utf8");
      log(`[${i + 1}/${tasks.length}] ${taskKey} -> NO_RECORD`);
      saveState(i + 1);
      await sleep(CONFIG.politeDelayMs);
      continue;
    }

    const parsed = parseHtml(fetched.html, task);

    if (!parsed.length) {
      fs.appendFileSync(FILES.failed, `${taskKey} | PARSE_EMPTY\n`, "utf8");
      log(`[${i + 1}/${tasks.length}] ${taskKey} -> PARSE_EMPTY`);
      saveState(i + 1);
      await sleep(CONFIG.politeDelayMs);
      continue;
    }

    const regBranch = parseRegNo(task.reg_no).branch_code_from_reg;
    if (normalize(regBranch) !== normalize(task.branch_code_input)) {
      fs.appendFileSync(
        FILES.failed,
        `${taskKey} | BRANCH_CODE_INPUT_MISMATCH | reg=${regBranch} | input=${task.branch_code_input}\n`,
        "utf8"
      );
      log(`[${i + 1}/${tasks.length}] ${taskKey} -> BRANCH_CODE_INPUT_MISMATCH reg=${regBranch} input=${task.branch_code_input}`);
    }

    appendRawRows(parsed);
    appendUnique(FILES.seen, seen, taskKey);
    rebuildOutputsFromRaw();

    log(
      `[${i + 1}/${tasks.length}] ${taskKey} -> OK | branch=${task.branch_code_input} | sem=${task.sem} | subjects=${parsed.length}`
    );

    saveState(i + 1);
    await sleep(CONFIG.politeDelayMs);
  }

  rebuildOutputsFromRaw();
  log(`COMPLETE all tasks finished`);
}

run().catch(err => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
