/**
 * 우리동네 빈자리 어린이집 찾기 - 데이터 수집
 * 어린이집정보공개포털 cpmsapi030 (어린이집별 기본정보 조회)
 *
 * 실행:  CHILDCARE_KEY=인증키 node collect.js
 * 일부만:  CHILDCARE_KEY=인증키 ONLY=41450,11710 node collect.js
 *
 * 결과:  data/41450.json  (시군구별)
 *        data/index.json  (수집된 시군구 목록)
 */

const fs = require('fs');
const path = require('path');

// ── 설정 ───────────────────────────────────────────────
const API_URL = 'http://api.childcare.go.kr/mediate/rest/cpmsapi030/cpmsapi030/request';
const DATA_DIR = path.join(__dirname, 'data');
const REGIONS_FILE = path.join(__dirname, 'regions.json');

const CONCURRENCY = 3;      // 동시 호출 수
const GAP_MS = 300;         // 호출 간격
const RETRY = 2;            // 실패 시 재시도 횟수
const TIMEOUT_MS = 20000;

// 응답에 들어 있는 항목은 이름을 가리지 않고 모두 저장합니다.
// (항목 이름을 미리 정해두면, API가 조금만 달라져도 값이 통째로 사라집니다)

// ── 인증키 ─────────────────────────────────────────────
const KEY = process.env.CHILDCARE_KEY;
if (!KEY) {
  console.error('CHILDCARE_KEY 환경변수가 없습니다. 수집을 중단합니다.');
  process.exit(1);
}

// ── 시군구 목록 ─────────────────────────────────────────
function loadRegions() {
  if (!fs.existsSync(REGIONS_FILE)) {
    console.error('regions.json 이 없습니다. make-regions.js 를 먼저 실행하세요.');
    process.exit(1);
  }
  let list = JSON.parse(fs.readFileSync(REGIONS_FILE, 'utf8'));

  const only = process.env.ONLY;
  if (only) {
    const set = new Set(only.split(',').map(s => s.trim()));
    list = list.filter(r => set.has(r.code));
    console.log(`ONLY 지정 → ${list.length}개 시군구만 수집합니다.`);
  }
  return list;
}

// ── XML 파싱 (의존성 없이 item 단위로 추출) ───────────────
function unescapeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function parseItems(xml) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const obj = {};
    const tagRe = /<([A-Za-z_][\w.\-]*)>([\s\S]*?)<\/\1>/g;
    let t;
    while ((t = tagRe.exec(body)) !== null) {
      obj[t[1]] = unescapeXml(t[2]);
    }
    items.push(obj);
  }
  return items;
}

function slim(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = v;
  }
  return out;
}

// ── 개발키 감지 ─────────────────────────────────────────
function looksLikeDevKey(items) {
  // 개발계정은 연령별 값이 01, 02 같은 더미로만 내려옴
  const sample = items.slice(0, 20);
  if (sample.length === 0) return false;
  const dummy = sample.filter(it => {
    const v = [it.child_cnt_00, it.child_cnt_01, it.child_cnt_02].filter(Boolean);
    return v.length > 0 && v.every(x => x === '01' || x === '02' || x === '0');
  });
  return dummy.length === sample.length;
}

// ── HTTP ───────────────────────────────────────────────
async function fetchRegion(code) {
  const url = `${API_URL}?key=${encodeURIComponent(KEY)}&arcode=${encodeURIComponent(code)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (/<result[^>]*>\s*(?!00)/.test(xml) && /오류|error|ERROR/.test(xml) && !/<item[^>]*>/.test(xml)) {
      throw new Error('API 오류 응답: ' + xml.slice(0, 200));
    }
    return parseItems(xml);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(code) {
  let lastErr;
  for (let i = 0; i <= RETRY; i++) {
    try {
      return await fetchRegion(code);
    } catch (e) {
      lastErr = e;
      if (i < RETRY) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 메인 ───────────────────────────────────────────────
async function main() {
  const regions = loadRegions();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const stamp = new Date().toISOString();
  const results = [];
  const failed = [];
  let devKeyWarned = false;
  let cursor = 0;

  async function worker(id) {
    while (cursor < regions.length) {
      const r = regions[cursor++];
      const n = cursor;
      try {
        const raw = await fetchWithRetry(r.code);
        const items = raw.map(slim).filter(it => it.stcode);

        if (items.length === 0) {
          console.log(`  · ${r.code} ${r.name} — 결과 0건 (기존 파일 유지)`);
          failed.push(r.code);
          continue;
        }

        if (!devKeyWarned && looksLikeDevKey(items)) {
          devKeyWarned = true;
          console.warn('\n  ⚠ 개발계정 인증키로 보입니다. 연령별 숫자가 더미(01/02)입니다.');
          console.warn('    운영계정 승인 후 인증키를 교체하세요.\n');
        }

        fs.writeFileSync(
          path.join(DATA_DIR, `${r.code}.json`),
          JSON.stringify({ arcode: r.code, name: r.name, updated: stamp, count: items.length, items })
        );
        results.push({ code: r.code, name: r.name, count: items.length });
        console.log(`  ✓ ${r.code} ${r.name} — ${items.length}곳  (${n}/${regions.length})`);
      } catch (e) {
        failed.push(r.code);
        console.log(`  ✗ ${r.code} ${r.name} — ${e.message} (기존 파일 유지)`);
      }
      await sleep(GAP_MS);
    }
  }

  console.log(`\n수집 시작: ${regions.length}개 시군구\n`);
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  // 전부 실패하면 index.json 도 건드리지 않음
  if (results.length === 0) {
    console.error('\n모든 시군구 수집 실패. 기존 데이터를 그대로 둡니다.');
    process.exit(1);
  }

  // 이번에 실패한 시군구는 기존 index 정보를 살려둠
  let prev = { regions: [] };
  const indexPath = path.join(DATA_DIR, 'index.json');
  if (fs.existsSync(indexPath)) {
    try { prev = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (_) {}
  }
  const merged = new Map((prev.regions || []).map(r => [r.code, r]));
  for (const r of results) merged.set(r.code, r);

  fs.writeFileSync(indexPath, JSON.stringify({
    updated: stamp,
    total: [...merged.values()].reduce((s, r) => s + (r.count || 0), 0),
    regions: [...merged.values()].sort((a, b) => a.code.localeCompare(b.code)),
  }));

  console.log(`\n완료: 성공 ${results.length}곳 / 실패 ${failed.length}곳`);
  if (failed.length) console.log(`실패 목록: ${failed.join(', ')}`);
}

main().catch(e => {
  console.error('예상치 못한 오류:', e);
  process.exit(1);
});
