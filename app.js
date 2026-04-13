require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const XLSX = require("xlsx");

// ===== 파일 경로 =====
const STATE_PATH = path.join(__dirname, "seen_state.json");
const XLSX_PATH = path.join(__dirname, "주차알림대상.xlsx");
const LAST_RESPONSE_PATH = path.join(__dirname, "last_response.html");

// ===== ENV =====
const {
  BASE_URL,
  PHPSESSID,
  CORP_SN,
  POLL_SECONDS,

  WATCH_VEHICLES,

  // SOLAPI 공통
  SOLAPI_API_KEY,
  SOLAPI_API_SECRET,

  // 알림톡(ATA)
  SOLAPI_PFID,
  SOLAPI_TEMPLATE_ID,
  SOLAPI_TEMPLATE_CODE, // 호환

  // 기본 수신자(엑셀 수신자 없을 때 fallback)
  ALERT_TO,

  // 발송 모드: auto(알림톡→실패시문자) / ata(알림톡만) / sms(문자만)
  SEND_MODE,

  // 문자 발신번호(솔라피에 등록/인증된 번호)
  SMS_FROM,

  // 감시 시작 알림: me / none
  START_NOTIFY_MODE,
  START_NOTIFY_TO,
} = process.env;

// ===== 기본 체크 =====
if (!BASE_URL || !PHPSESSID) {
  console.error("❌ .env에 BASE_URL / PHPSESSID가 필요합니다.");
  process.exit(1);
}
if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET) {
  console.error("❌ .env에 SOLAPI_API_KEY / SOLAPI_API_SECRET 가 필요합니다.");
  process.exit(1);
}

// templateId는 SOLAPI_TEMPLATE_ID 우선, 없으면 SOLAPI_TEMPLATE_CODE 사용(호환)
const TEMPLATE_ID = SOLAPI_TEMPLATE_ID || SOLAPI_TEMPLATE_CODE;

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}
function fmtKST(d = new Date()) {
  return d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function dateMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function normPhone(s) {
  return String(s || "").replace(/[^0-9]/g, "");
}
function normalizeVehicle(s) {
  return String(s || "").replace(/\s+/g, "").trim();
}

// ===== 수신자 파싱 =====
function parsePhones(raw) {
  // 콤마/세미콜론/공백 섞여도 처리
  return String(raw || "")
    .split(/[,;]+/)
    .map((s) => normPhone(s))
    .filter(Boolean);
}
function getDefaultReceivers() {
  const list = parsePhones(ALERT_TO);
  if (!list.length) {
    throw new Error(".env ALERT_TO 비어있음. 예) ALERT_TO=010...,010...");
  }
  return list;
}

// 감시 시작 알림 수신자 (나한테만 or 없음)
function getStartReceivers() {
  const mode = String(START_NOTIFY_MODE || "me").toLowerCase();
  if (mode === "none") return [];

  const me = normPhone(START_NOTIFY_TO || "");
  if (me) return [me];

  const all = getDefaultReceivers();
  return [all[0]];
}

// ===== 엑셀 로드 =====
// 시트1 컬럼: 차량번호 / 이름 / 직급 / 회사명 / 수신자1 / 수신자2 / ...
// 시트2 컬럼: 이름 / 전화번호  (이름으로 조회해서 번호 변환)
function loadFromXlsx() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`❌ 엑셀 파일 없음: ${XLSX_PATH}`);
    console.error("   주차알림대상.xlsx 를 app.js 있는 폴더에 넣어주세요.");
    process.exit(1);
  }

  const wb = XLSX.readFile(XLSX_PATH);

  // 시트2: 이름 -> 전화번호 사전
  const contactMap = {};
  if (wb.SheetNames[1]) {
    const ws2 = wb.Sheets[wb.SheetNames[1]];
    const contactRows = XLSX.utils.sheet_to_json(ws2, { defval: "" });
    for (const c of contactRows) {
      const cName = String(c["이름"] || "").trim();
      const cPhone = normPhone(String(c["전화번호"] || ""));
      if (cName && cPhone) contactMap[cName] = cPhone;
    }
  }

  // 이름 또는 전화번호를 전화번호로 변환
  function resolvePhone(val) {
    const s = String(val || "").trim();
    if (!s) return "";
    if (contactMap[s]) return contactMap[s]; // 이름이면 사전 조회
    return normPhone(s); // 숫자면 그대로
  }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const vehicleMetaMap = {}; // 차량번호 -> {company, owner, receivers[]}
  const vehicles = [];

  const companyReceiversMap = {}; // 회사명 -> Set(전화)

  for (const r of rows) {
    const v = normalizeVehicle(r["차량번호"]);
    if (!v) continue;

    const name = String(r["이름"] || "").trim();
    const role = String(r["직급"] || "").trim();
    const company = String(r["회사명"] || "").trim() || "-";

    // 수신자1, 수신자2, ... 컬럼 수집 (이름 또는 번호 모두 허용)
    const receivers = [];
    for (const key of Object.keys(r)) {
      if (/^수신자\d*$/.test(key)) {
        const phone = resolvePhone(r[key]);
        if (phone) receivers.push(phone);
      }
    }

    vehicleMetaMap[v] = {
      company,
      owner: `${name} ${role}`.trim() || "-",
      receivers,
    };

    vehicles.push(v);

    if (!companyReceiversMap[company]) companyReceiversMap[company] = new Set();
    for (const p of receivers) companyReceiversMap[company].add(p);
  }

  if (!vehicles.length) {
    console.error("❌ 엑셀에서 차량번호를 하나도 못 읽었어요.");
    console.error("   시트1 헤더가 '차량번호/이름/직급/회사명/수신자1/수신자2/...'인지 확인해주세요.");
    process.exit(1);
  }

  // WATCH_VEHICLES가 있으면 그거만 감시(엑셀에 존재하는 차량만)
  let watchSet;
  if (WATCH_VEHICLES && WATCH_VEHICLES.trim()) {
    const want = new Set(
      WATCH_VEHICLES.split(",").map((s) => normalizeVehicle(s)).filter(Boolean)
    );
    watchSet = new Set(vehicles.filter((v) => want.has(v)));
  } else {
    watchSet = new Set(vehicles);
  }

  if (!watchSet.size) {
    console.error("❌ 감시할 차량이 0대입니다.");
    console.error("   WATCH_VEHICLES를 넣었다면 엑셀에 존재하는 번호인지 확인해주세요.");
    process.exit(1);
  }

  // Set -> Array로 변환해서 저장
  const companyReceivers = {};
  for (const [k, set] of Object.entries(companyReceiversMap)) {
    companyReceivers[k] = [...set];
  }

  return { vehicleMetaMap, companyReceivers, watchSet };
}

// ===== 출입로그 조회 =====
async function fetchInOutRows({ vehicle = "", startDate = null } = {}) {
  const url = `${BASE_URL}/api/searchinoutlist.php`;

  const start = startDate || ymd(dateMinus(2));
  const end = ymd(new Date());

  const form = new URLSearchParams();
  form.set("corp_sn", String(CORP_SN || "2"));
  form.set("startdate", start);
  form.set("enddate", end);
  form.set("vehicle", vehicle);
  form.set("p", "1");

  const res = await axios.post(url, form, {
    headers: {
      Accept: "text/plain, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/inoutlist`,
      Cookie: `PHPSESSID=${PHPSESSID}`,
    },
    timeout: 15000,
    validateStatus: () => true,
    maxRedirects: 0,
  });

  // 디버그 저장 (전체 조회만)
  if (!vehicle) {
    try {
      fs.writeFileSync(LAST_RESPONSE_PATH, String(res.data || ""), "utf-8");
    } catch {}
  }

  if (res.status === 302) {
    throw new Error("HTTP 302 (세션 만료/로그인 필요) → PHPSESSID 새로 교체하세요.");
  }
  if (res.status !== 200) throw new Error(`로그 API HTTP ${res.status}`);

  const html = String(res.data || "").trim();

  // 응답이 <tr>만 오는 경우 대비해서 감싸기
  const wrapped = `<table><tbody>${html}</tbody></table>`;
  const $ = cheerio.load(wrapped);

  const rows = [];
  $("tr").each((_, tr) => {
    const tds = $(tr)
      .find("td")
      .map((_, td) => $(td).text().trim())
      .get();

    if (tds.length >= 3) {
      const [vehicleNo, type, inTime, outTime] = tds;
      rows.push({
        vehicleNo: normalizeVehicle(vehicleNo),
        type: (type || "").trim(),
        inTime: (inTime || "").trim(),
        outTime: (outTime || "").trim(),
      });
    }
  });

  return rows;
}

// ===== SOLAPI 공통(HMAC) =====
function makeSolapiAuthHeader(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const hmac = crypto
    .createHmac("sha256", apiSecret)
    .update(date + salt)
    .digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${hmac}`;
}

// ===== 알림 변수 만들기 =====
function buildTemplateVars({ company, vehicle, owner, in_time, out_time }) {
  const safe = {
    company: String(company || "-"),
    vehicle: String(vehicle || "-"),
    owner: String(owner || "-"),
    in_time: String(in_time || "-"),
    out_time: String(out_time || "-"),
  };

  return {
    "#{company}": safe.company,
    "#{vehicle}": safe.vehicle,
    "#{owner}": safe.owner,
    "#{in_time}": safe.in_time,
    "#{out_time}": safe.out_time,
  };
}

// ===== SOLAPI: 알림톡(ATA) =====
async function sendATA({ to, variables }) {
  if (!SOLAPI_PFID) throw new Error("SOLAPI_PFID 없음(pfId 필요)");
  if (!TEMPLATE_ID) throw new Error("SOLAPI_TEMPLATE_ID(또는 SOLAPI_TEMPLATE_CODE) 없음");

  const url = "https://api.solapi.com/messages/v4/send";
  const body = {
    message: {
      to,
      type: "ATA",
      kakaoOptions: {
        pfId: SOLAPI_PFID,
        templateId: TEMPLATE_ID,
        variables,
      },
    },
  };

  const headers = {
    Authorization: makeSolapiAuthHeader(SOLAPI_API_KEY, SOLAPI_API_SECRET),
    "Content-Type": "application/json",
  };

  const res = await axios.post(url, body, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`SOLAPI ATA HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ===== SOLAPI: 문자(LMS) =====
function buildLMSText({ company, vehicle, owner, in_time, out_time }) {
  return (
    `차량 출입 알림\n` +
    `[Web발신]\n` +
    `[${company}]\n` +
    `차량번호: ${vehicle}\n` +
    `대상: ${owner}\n` +
    `입차: ${in_time}\n` +
    `출차: ${out_time}`
  );
}

async function sendLMS({ to, text }) {
  if (!SMS_FROM) throw new Error("SMS_FROM 없음(등록/인증된 발신번호 필요)");

  const url = "https://api.solapi.com/messages/v4/send";
  const body = {
    message: {
      to,
      from: normPhone(SMS_FROM),
      type: "LMS",
      subject: "차량 출입 알림",
      text,
    },
  };

  const headers = {
    Authorization: makeSolapiAuthHeader(SOLAPI_API_KEY, SOLAPI_API_SECRET),
    "Content-Type": "application/json",
  };

  const res = await axios.post(url, body, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`SOLAPI LMS HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ===== 수신자 결정 규칙 =====
// 1) 차량별 수신자(엑셀 수신자) 있으면 그걸 사용
// 2) 없으면 같은 회사명으로 모인 수신자(엑셀) 사용
// 3) 없으면 .env ALERT_TO fallback
function resolveReceivers(vehicleNo, meta, companyReceivers) {
  const byVehicle = (meta?.receivers || []).map(normPhone).filter(Boolean);
  if (byVehicle.length) return [...new Set(byVehicle)];

  const byCompany = (companyReceivers?.[meta?.company] || [])
    .map(normPhone)
    .filter(Boolean);
  if (byCompany.length) return [...new Set(byCompany)];

  return getDefaultReceivers();
}

// ===== 지정 수신자에게 발송 (알림톡 1순위 → 실패시 문자) =====
async function sendNotifyTo(receivers, payload) {
  const mode = String(SEND_MODE || "auto").toLowerCase();

  for (const toRaw of receivers) {
    const to = normPhone(toRaw);
    if (!to) continue;

    if (mode === "sms") {
      await sendLMS({ to, text: buildLMSText(payload) });
      console.log(`📩 문자(LMS) 전송 → ${to}`);
      continue;
    }

    if (mode === "ata") {
      await sendATA({ to, variables: buildTemplateVars(payload) });
      console.log(`📩 알림톡(ATA) 전송 → ${to}`);
      continue;
    }

    // auto: ✅ 무조건 ATA 먼저 시도, 실패하면 LMS
    try {
      await sendATA({ to, variables: buildTemplateVars(payload) });
      console.log(`📩 알림톡(ATA) 전송 → ${to}`);
    } catch (e) {
      console.log(`⚠️ 알림톡 실패 → 문자(LMS) 대체: ${to}`);
      console.log("   FAIL:", e.response?.data || e.message);
      await sendLMS({ to, text: buildLMSText(payload) });
      console.log(`📩 문자(LMS) 대체 전송 → ${to}`);
    }
  }
}

// ===== pending 출차 확인 (페이지 밀린 차량 전용) =====
async function checkPendingExits(state, vehicleMetaMap, companyReceivers, watchSet) {
  const pending = state.pending_out || {};
  const keys = Object.keys(pending);
  if (!keys.length) return;

  for (const pendingKey of keys) {
    const pipeIdx = pendingKey.indexOf("|");
    const vehicleNo = pendingKey.slice(0, pipeIdx);
    const inTime = pendingKey.slice(pipeIdx + 1);

    // 감시 대상 아니면 제거
    if (!watchSet.has(vehicleNo)) {
      delete state.pending_out[pendingKey];
      writeJson(STATE_PATH, state);
      continue;
    }

    // 3일 초과 pending은 만료 처리
    const addedAt = pending[pendingKey];
    if (typeof addedAt === "number" && Date.now() - addedAt > 3 * 24 * 60 * 60 * 1000) {
      console.log(`⏰ pending 만료(3일 초과): ${pendingKey}`);
      delete state.pending_out[pendingKey];
      writeJson(STATE_PATH, state);
      continue;
    }

    // 입차 날짜 기준으로 해당 차량만 재조회
    const inDate = inTime.split(" ")[0];

    try {
      const rows = await fetchInOutRows({ vehicle: vehicleNo, startDate: inDate });

      for (const r of rows) {
        if (r.vehicleNo !== vehicleNo) continue;
        if ((r.inTime || "").trim() !== inTime) continue; // 같은 입차 기록만

        if (r.outTime) {
          const outKey = `${vehicleNo}|${r.outTime}`;
          // pending 제거
          delete state.pending_out[pendingKey];

          if (!state.seen_out[outKey]) {
            state.seen_out[outKey] = Date.now();
            writeJson(STATE_PATH, state);

            const meta = vehicleMetaMap[vehicleNo] || { company: "-", owner: "-", receivers: [] };
            const receivers = resolveReceivers(vehicleNo, meta, companyReceivers);

            const payload = {
              company: meta.company,
              vehicle: vehicleNo,
              owner: meta.owner,
              in_time: inTime,
              out_time: r.outTime,
            };

            console.log(`🏁 [출차-추적] 수신자: ${receivers.join(",")}`);
            await sendNotifyTo(receivers, payload);
            console.log(`🏁 [출차-추적] 전송: ${outKey}`);
          } else {
            writeJson(STATE_PATH, state);
          }
        }
      }
    } catch (e) {
      console.error(`⚠️ pending 출차 확인 에러 (${vehicleNo}):`, e.message);
    }
  }
}

// ===== 감시 루프 =====
async function runMonitor() {
  const { vehicleMetaMap, companyReceivers, watchSet } = loadFromXlsx();

  const state = readJsonSafe(STATE_PATH, { seen_in: {}, seen_out: {}, pending_out: {} });
  state.seen_in = state.seen_in || {};
  state.seen_out = state.seen_out || {};
  state.pending_out = state.pending_out || {};

  const pollSec = Math.max(5, Number(POLL_SECONDS || 5));

  console.log("✅ 감시 시작");
  console.log("감시 차량:", [...watchSet].join(", "));
  console.log(`주기: ${pollSec}초`);
  console.log("현재시각(KST):", fmtKST());

  // ✅ 감시 시작 알림(선택)
  const startReceivers = getStartReceivers();
  if (startReceivers.length) {
    const payload = {
      company: "감시 시스템",
      vehicle: "-",
      owner: "감시 시작",
      in_time: fmtKST(),
      out_time: "-",
    };
    await sendNotifyTo(startReceivers, payload);
    console.log("✅ 감시 시작 알림 전송 완료(나에게만)");
  } else {
    console.log("ℹ️ 감시 시작 알림 비활성화(START_NOTIFY_MODE=none)");
  }

  while (true) {
    try {
      const rows = await fetchInOutRows();

      const matched = rows.filter((r) => watchSet.has(r.vehicleNo)).length;
      console.log(`📄 조회 성공: rows=${rows.length}, 매칭=${matched} (${fmtKST()})`);

      for (const r of rows) {
        if (!watchSet.has(r.vehicleNo)) continue;

        const meta = vehicleMetaMap[r.vehicleNo] || { company: "-", owner: "-", receivers: [] };
        const receivers = resolveReceivers(r.vehicleNo, meta, companyReceivers);

        // 입차 이벤트
        if (r.inTime) {
          const inKey = `${r.vehicleNo}|${r.inTime}`;
          if (!state.seen_in[inKey]) {
            state.seen_in[inKey] = Date.now();
            writeJson(STATE_PATH, state);

            const payload = {
              company: meta.company,
              vehicle: r.vehicleNo,
              owner: meta.owner,
              in_time: r.inTime,
              out_time: r.outTime ? r.outTime : "-",
            };

            console.log("🚗 [입차] 수신자:", receivers.join(","));
            await sendNotifyTo(receivers, payload);
            console.log("🚗 [입차] 전송:", inKey);
          }

          // 아직 출차 안 됐으면 pending 등록 (나중에 출차 추적용)
          if (!r.outTime) {
            const pendingKey = `${r.vehicleNo}|${r.inTime}`;
            if (!state.pending_out[pendingKey]) {
              state.pending_out[pendingKey] = Date.now();
              writeJson(STATE_PATH, state);
            }
          }
        }

        // 출차 이벤트
        if (r.outTime) {
          // pending에서 제거 (입차시간 기준으로 매칭)
          const pendingKey = `${r.vehicleNo}|${r.inTime}`;
          if (state.pending_out[pendingKey]) {
            delete state.pending_out[pendingKey];
          }

          const outKey = `${r.vehicleNo}|${r.outTime}`;
          if (!state.seen_out[outKey]) {
            state.seen_out[outKey] = Date.now();
            writeJson(STATE_PATH, state);

            const payload = {
              company: meta.company,
              vehicle: r.vehicleNo,
              owner: meta.owner,
              in_time: r.inTime ? r.inTime : "-",
              out_time: r.outTime,
            };

            console.log("🏁 [출차] 수신자:", receivers.join(","));
            await sendNotifyTo(receivers, payload);
            console.log("🏁 [출차] 전송:", outKey);
          }
        }
      }

      if (rows.length === 0) {
        console.log("⚠️ rows=0 입니다. last_response.html 확인 필요(로그인페이지/권한/형식변경 가능).");
      }

      // 페이지 밀린 차량 출차 추적
      if (Object.keys(state.pending_out).length) {
        await checkPendingExits(state, vehicleMetaMap, companyReceivers, watchSet);
      }
    } catch (e) {
      console.error("⚠️ 에러:", e.response?.data || e.message);
      console.error("   (세션만료면 PHPSESSID 새 값으로 교체 필요)");
    }

    await sleep(pollSec * 1000);
  }
}

// ===== 테스트(즉시 1건 발송) =====
async function testSend() {
  const payload = {
    company: "화성센터",
    vehicle: "33마5154",
    owner: "황교득 대리",
    in_time: "2026-02-03 09:00",
    out_time: "-",
  };

  // 테스트는 기본 수신자 또는 엑셀 수신자 사용
  const receivers = getDefaultReceivers();
  await sendNotifyTo(receivers, payload);
  console.log("✅ test 전송 완료");
}

// ===== 실행 =====
(async () => {
  const cmd = (process.argv[2] || "").toLowerCase();

  if (cmd === "run") return runMonitor();
  if (cmd === "test") return testSend();

  console.log("사용법:");
  console.log("  node app.js test   # 1건 테스트 발송");
  console.log("  node app.js run    # 감시 시작(엑셀 기준)");
})();
