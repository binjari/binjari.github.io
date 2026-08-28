/**
 * regions.json 만들기
 *
 * 1. https://www.code.go.kr 접속
 * 2. 검색창에 "법정동코드" → [법정동코드 전체자료] 다운로드
 * 3. 받은 txt 파일을 이 스크립트와 같은 폴더에 두고 이름을 bjd.txt 로 변경
 * 4. node make-regions.js
 *
 * 결과: regions.json  (시군구 코드 5자리 + 이름)
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'bjd.txt');
const OUT = path.join(__dirname, 'regions.json');

if (!fs.existsSync(SRC)) {
  console.error('bjd.txt 가 없습니다. code.go.kr 에서 법정동코드 전체자료를 받아 bjd.txt 로 저장하세요.');
  process.exit(1);
}

// code.go.kr 파일은 보통 EUC-KR. 깨지면 UTF-8로 다시 읽음
const buf = fs.readFileSync(SRC);
let text;
try {
  text = new TextDecoder('euc-kr').decode(buf);
  if (!text.includes('서울')) throw new Error('euc-kr 아님');
} catch (_) {
  text = buf.toString('utf8');
}

const lines = text.split(/\r?\n/).filter(Boolean);
const seen = new Map();

for (const line of lines) {
  const cols = line.split('\t').map(s => s.trim());
  if (cols.length < 2) continue;

  const code = cols[0];
  const name = cols[1];
  const status = cols[2] || '존재';

  if (!/^\d{10}$/.test(code)) continue;   // 헤더 등 건너뜀
  if (status.includes('폐지')) continue;

  // 시군구 단위 = 뒤 5자리가 00000, 단 시도 단위(뒤 8자리 0)는 제외
  if (!code.endsWith('00000')) continue;
  const isSido = code.endsWith('00000000');

  const sgg = code.slice(0, 5);

  // 세종시처럼 시군구가 없는 광역시는 시도 코드를 그대로 사용
  if (isSido && !name.includes('세종')) continue;

  if (!seen.has(sgg)) seen.set(sgg, name);
}

const regions = [...seen.entries()]
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.code.localeCompare(b.code));

fs.writeFileSync(OUT, JSON.stringify(regions, null, 2));

console.log(`regions.json 생성 완료 — ${regions.length}개 시군구`);
console.log('앞 5개 미리보기:');
regions.slice(0, 5).forEach(r => console.log(`  ${r.code}  ${r.name}`));
