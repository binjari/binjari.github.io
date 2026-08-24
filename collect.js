/**
 * 우리동네 빈자리 어린이집 찾기 — 매일 오전 7시 데이터 수집
 *
 * 어린이집정보공개포털 OPEN API (cpmsapi030) 를 시군구별로 호출해
 * data/childcare.json 파일을 새로 씁니다.
 *
 * 인증키는 이 파일에 적지 않습니다. 환경변수 CHILDCARE_KEY 로 받습니다.
 *   로컬 실행:  CHILDCARE_KEY=발급받은키 node collect.js
 *   GitHub:    저장소 Settings → Secrets → CHILDCARE_KEY 에 저장
 *
 * Node 18 이상이면 별도 설치 없이 그대로 돌아갑니다.
 */

const fs = require('fs');
const path = require('path');

const KEY = process.env.CHILDCARE_KEY;
const API = 'http://api.childcare.go.kr/mediate/rest/cpmsapi030/cpmsapi030/request';

/* ─────────────────────────────────────────────────────────────
   수집할 시군구.  arcode 는 행정표준코드(5자리)입니다.
   행정표준코드관리시스템(www.code.go.kr)에서 확인할 수 있고,
   아래 값은 반드시 첫 실행 때 결과를 눈으로 확인해 주세요.
   지역을 넓히려면 이 목록에 줄을 추가하기만 하면 됩니다.
   ───────────────────────────────────────────────────────────── */
const REGIONS = [
  { arcode: '41450', name: '경기도 하남시' },
  { arcode: '11290', name: '서울특별시 성북구' },
  { arcode: '11440', name: '서울특별시 마포구' }
];

const DELAY_MS = 1500;          // 호출 간격 (트래픽 한도 보호)
const RETRY    = 3;             // 실패 시 재시도 횟수

/* ── 응답 XML에서 항목 뽑기 (외부 라이브러리 없이) ── */
function parseItems(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map(block => {
    const get = tag => {
      const m = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
      return m ? m[1].trim() : '';
    };
    const num = tag => {
      const v = parseInt(get(tag), 10);
      return Number.isNaN(v) ? null : v;
    };

    const rec = {
      stcode      : get('stcode'),
      crname      : get('crname'),
      crtypename  : get('crtypename'),
      crstatusname: get('crstatusname'),
      sidoname    : get('sidoname'),
      sigunguname : get('sigunguname'),
      craddr      : get('craddr'),
      crtelno     : get('crtelno'),
      crcapat     : num('crcapat'),      // 정원
      crchcnt     : num('crchcnt'),      // 현원
      em_cnt_a2   : num('em_cnt_a2'),    // 보육교사 수
      la          : get('la'),
      lo          : get('lo'),
      datastdrdt  : get('datastdrdt')
    };

    for (let a = 0; a <= 5; a++) {
      const k = '0' + a;
      rec['class_cnt_' + k] = num('class_cnt_' + k);   // 반 수
      rec['child_cnt_' + k] = num('child_cnt_' + k);   // 아동 수
      rec['ew_cnt_' + k]    = num('ew_cnt_' + k);      // 입소대기 아동 수
    }

    rec._emd = extractEmd(rec.craddr);
    return rec;
  });
}

/* 주소에서 동·읍·면 뽑기. 도로명주소에는 동이 없어 빈 값이 될 수 있습니다.
   그 경우 앱은 시군구 단위로 보여주며, juso.go.kr 연동 시 정확해집니다. */
function extractEmd(addr) {
  const m = (addr || '').match(/(?:^|\s)([가-힣]{1,6}\d{0,2}(?:동|읍|면))(?=\s|$)/g);
  return m ? m[m.length - 1].trim() : '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRegion(region) {
  const url = `${API}?key=${encodeURIComponent(KEY)}&arcode=${region.arcode}&stcode=`;
  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const xml = await res.text();
      const rows = parseItems(xml);
      if (!rows.length) throw new Error('결과가 비어 있습니다');
      return rows;
    } catch (e) {
      console.warn(`  ${region.name} ${attempt}차 실패: ${e.message}`);
      if (attempt === RETRY) throw e;
      await sleep(3000 * attempt);
    }
  }
}

async function main() {
  if (!KEY) {
    console.error('CHILDCARE_KEY 환경변수가 없습니다. 인증키를 설정한 뒤 다시 실행하세요.');
    process.exit(1);
  }

  const all = [];
  const failed = [];

  for (const region of REGIONS) {
    process.stdout.write(`${region.name} 수집 중... `);
    try {
      const rows = await fetchRegion(region);
      const live = rows.filter(r => r.crstatusname !== '폐지');
      all.push(...live);
      console.log(`${live.length}곳`);
    } catch (e) {
      failed.push(region.name);
      console.log('실패');
    }
    await sleep(DELAY_MS);
  }

  /* 전부 실패하면 기존 파일을 덮어쓰지 않습니다.
     빈 화면을 보여주느니 어제 데이터를 그대로 두는 편이 낫습니다. */
  if (!all.length) {
    console.error('수집된 데이터가 없어 파일을 갱신하지 않습니다.');
    process.exit(1);
  }

  const outPath = path.join(__dirname, 'data', 'childcare.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(all, null, 0), 'utf8');

  const meta = {
    updatedAt : new Date().toISOString(),
    count     : all.length,
    regions   : REGIONS.map(r => r.name),
    failed
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log(`\n총 ${all.length}곳 저장 완료`);
  if (failed.length) console.log(`실패한 지역: ${failed.join(', ')}`);

  /* 개발키로 돌리면 값이 01, 02 같은 더미로 나옵니다. 바로 알려줍니다. */
  const sample = all.find(r => r.crcapat != null);
  if (sample && sample.crcapat < 5 && sample.crchcnt < 5) {
    console.warn('\n⚠ 정원·현원 값이 비정상적으로 작습니다. 개발계정 키를 쓰고 계신 것 같습니다.');
    console.warn('  실제 숫자를 받으려면 운영계정 인증키가 필요합니다.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
