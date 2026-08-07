// /api/apt?kind=list&lawd=41593        → 시군구 내 K-apt 단지 목록 (kaptCode, kaptName, 주소)
// /api/apt?kind=info&kapt=A10027875    → 단지 기본정보 (세대수/동수/주차/난방/사용승인일 등)
//
// 국토교통부_공동주택 기본/목록 정보제공 서비스 프록시
// 엔드포인트가 기관코드(1613000 V3 / 1611000 구버전)로 갈라져 있어 순차 폴백한다.

// auth:20(접근거부)이 난 AptListService3/getSigunguAptList3가 실제 존재하는 서비스.
// → 이를 최우선으로. (20은 오퍼레이션은 있으나 활용신청 미승인/동기화 대기 신호)
const LIST_EPS = (function(){
  var out = [
    { url: 'https://apis.data.go.kr/1613000/AptListService3/getSigunguAptList3', param: 'sigunguCode' }
  ];
  var svcVers = ['3', '4', '2', ''];
  var opVers  = ['3', '4', '2', ''];
  svcVers.forEach(function(sv){
    opVers.forEach(function(ov){
      var url = 'https://apis.data.go.kr/1613000/AptListService' + sv + '/getSigunguAptList' + ov;
      if (!out.some(function(o){ return o.url === url; })) out.push({ url: url, param: 'sigunguCode' });
    });
  });
  out.push({ url: 'https://apis.data.go.kr/1611000/AptListService/getSigunguAptList', param: 'sigunguCode' });
  return out;
})();

const INFO_EPS = [
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfo',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusBassInfoV2',
  'https://apis.data.go.kr/1611000/AptBasisInfoService/getAphusBassInfo'
];

// 상세정보(주차·지하철·편의시설). 기본정보와 같은 서비스의 다른 오퍼레이션.
const DETAIL_EPS = [
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusDtlInfoV3',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusDtlInfoV2'
];

function pick(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}
function toInt(s){ return parseInt(String(s).replace(/,/g, ''), 10) || 0; }
function toNum(s){ return parseFloat(String(s).replace(/,/g, '')) || 0; }

// 인증/공통 오류면 문자열 반환, 정상이면 null (XML/JSON 공통)
function errOf(text){
  const authErr = pick(text, 'returnReasonCode');
  if (authErr) return 'auth:' + authErr + ':' + (pick(text, 'returnAuthMsg') || pick(text, 'errMsg'));
  const m = text.match(/"returnReasonCode"\s*:\s*"?(\d+)"?/);
  if (m && m[1] !== '00' && m[1] !== '000') {
    const am = text.match(/"returnAuthMsg"\s*:\s*"([^"]*)"/);
    return 'auth:' + m[1] + ':' + (am ? am[1] : '');
  }
  const rc = pick(text, 'resultCode');
  if (rc && rc !== '000' && rc !== '00') return 'api:' + rc + ':' + pick(text, 'resultMsg');
  // JSON resultCode
  const jm = text.match(/"resultCode"\s*:\s*"?(\d+)"?/);
  if (jm && jm[1] !== '00' && jm[1] !== '000') {
    const rm = text.match(/"resultMsg"\s*:\s*"([^"]*)"/);
    return 'api:' + jm[1] + ':' + (rm ? rm[1] : '');
  }
  return null;
}

// 응답에서 첫 item을 뽑기 (JSON·XML 모두). 반환: item 객체 또는 null
function parseItem(text){
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      const body = j && j.response && j.response.body;
      if (!body) return null;
      let item = body.item;
      if (item == null && body.items != null) {
        item = Array.isArray(body.items) ? body.items[0]
             : (body.items.item != null ? (Array.isArray(body.items.item) ? body.items.item[0] : body.items.item)
                                         : body.items);
      }
      if (Array.isArray(item)) item = item[0];
      if (item && typeof item === 'object') return item;
    } catch (e) {}
    return null;
  }
  const block = (t.match(/<item>[\s\S]*?<\/item>/) || [t])[0];
  if (!pick(block, 'kaptCode') && !pick(block, 'kaptName')) return null;
  return { __xml: block };
}
// 여러 item을 배열로 (목록용). body.items(복수) 또는 body.item(단수) 모두 지원.
function parseItems(text){
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      const body = j && j.response && j.response.body;
      if (!body) return [];
      // 케이스1: body.items 가 배열
      if (Array.isArray(body.items)) return body.items;
      // 케이스2: body.items = { item: [...] } 또는 { item: {...} }
      if (body.items && body.items.item != null) {
        return Array.isArray(body.items.item) ? body.items.item : [body.items.item];
      }
      // 케이스3: body.item 이 배열/단일
      if (body.item != null) {
        return Array.isArray(body.item) ? body.item : [body.item];
      }
      return [];
    } catch (e) { return []; }
  }
  return (t.match(/<item>[\s\S]*?<\/item>/g) || []).map(function(b){ return { __xml: b }; });
}
// item에서 필드 꺼내기 (JSON 키 또는 XML 태그)
function f(item, key){
  if (!item) return '';
  if (item.__xml !== undefined) return pick(item.__xml, key);
  return item[key] != null ? String(item[key]).trim() : '';
}

export default async function handler(req, res) {
  const kind = req.query.kind === 'info' ? 'info' : 'list';
  const { lawd, kapt } = req.query;

  const rawKey = process.env.MOLIT_API_KEY;
  if (!rawKey) return res.status(500).json({ error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다.' });
  const raw = rawKey.trim();
  const key = raw.includes('%') ? raw : encodeURIComponent(raw);

  try {
    if (kind === 'list') {
      if (!/^\d{5}$/.test(lawd || '')) {
        return res.status(400).json({ error: 'lawd(5자리 시군구코드)가 필요합니다.' });
      }
      const tried = [];
      const debug = req.query.debug === '1';
      for (const ep of LIST_EPS) {
        const url = ep.url + '?serviceKey=' + key + '&' + ep.param + '=' + lawd
          + '&pageNo=1&numOfRows=1000&_type=json';
        let body = '';
        try {
          const r = await fetch(url);
          body = await r.text();
        } catch (e) {
          tried.push({ ep: ep.url, err: String(e) });
          continue;
        }
        const e = errOf(body);
        if (e){
          tried.push(debug ? { url: url.replace(key, 'KEY'), err: e, raw: body.slice(0, 300) } : { ep: ep.url, err: e });
          continue;
        }

        const rawItems = parseItems(body);
        const items = [];
        for (const it of rawItems) {
          const code = f(it, 'kaptCode');
          if (!code) continue;
          items.push({
            kaptCode: code,
            name: f(it, 'kaptName'),
            bjdCode: f(it, 'bjdCode'),
            addr: [f(it,'as1'), f(it,'as2'), f(it,'as3'), f(it,'as4')].filter(Boolean).join(' ')
          });
        }
        if (items.length) {
          res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
          return res.status(200).json({ count: items.length, items, source: ep.url });
        }
        tried.push(debug ? { url: url.replace(key, 'KEY'), err: 'empty', raw: body.slice(0, 300) } : { ep: ep.url, err: 'empty' });
      }
      return res.status(502).json({
        error: 'K-apt 단지목록 조회 실패', tried,
        hint: debug ? undefined : '원인 확인은 URL 뒤에 &debug=1 을 붙여 다시 호출하세요.'
      });
    }

    // kind === 'info'
    if (!/^[A-Za-z0-9]+$/.test(kapt || '')) {
      return res.status(400).json({ error: 'kapt(단지코드)가 필요합니다.' });
    }
    const tried = [];
    const dbg = req.query.debug === '1';
    for (const ep of INFO_EPS) {
      const url = ep + '?serviceKey=' + key + '&kaptCode=' + encodeURIComponent(kapt) + '&_type=json';
      let body = '';
      try {
        const r = await fetch(url);
        body = await r.text();
      } catch (e) {
        tried.push({ ep, err: String(e) });
        continue;
      }
      const e = errOf(body);
      if (e){ tried.push(dbg ? { ep, err: e, raw: body.slice(0,300) } : { ep, err: e }); continue; }

      const src = parseItem(body);
      if (!src || !f(src, 'kaptCode')){
        tried.push(dbg ? { ep, err: 'empty', raw: body.slice(0,300) } : { ep, err: 'empty' });
        continue;
      }

      const info = {
        kaptCode: f(src, 'kaptCode'),
        name: f(src, 'kaptName'),
        addr: f(src, 'kaptAddr'),
        roadAddr: f(src, 'doroJuso'),
        households: toInt(f(src, 'kaptdaCnt')),      // 세대수
        dongCnt: toInt(f(src, 'kaptDongCnt')),        // 동수
        useDate: f(src, 'kaptUsedate'),               // 사용승인일 (YYYYMMDD)
        heat: f(src, 'codeHeatNm'),                   // 난방방식
        hall: f(src, 'codeHallNm'),                   // 복도유형
        saleType: f(src, 'codeSaleNm'),               // 분양형태
        builder: f(src, 'kaptBcompany'),              // 시공사
        totalArea: toNum(f(src, 'kaptTarea'))         // 연면적
      };

      // 상세정보(주차·지하철·편의시설) 병합 시도 — 같은 kaptCode
      let detailSrc = 'none';
      let detailKeys = null;
      for (const dep of DETAIL_EPS) {
        try {
          const dr = await fetch(dep + '?serviceKey=' + key + '&kaptCode=' + encodeURIComponent(kapt) + '&_type=json');
          const dbody = await dr.text();
          if (errOf(dbody)) continue;
          const d = parseItem(dbody);
          if (!d || !f(d, 'kaptCode')) continue;
          info.parkingTotal = toInt(f(d, 'kaptdPcnt')) + toInt(f(d, 'kaptdPcntu')); // 지상+지하
          info.cctv = toInt(f(d, 'kaptdCccnt'));
          info.subwayLine = f(d, 'subwayLine');       // 지하철호선
          // 역명 필드명이 문서마다 달라 여러 후보 시도
          info.subwayStation = f(d, 'subwayStation') || f(d, 'subwayStationNm')
            || f(d, 'kaptdWtime') || f(d, 'subway') || f(d, 'subwayStationName');
          info.subwayWay = f(d, 'kaptdWtimesub');     // 지하철역까지 소요
          info.busWay = f(d, 'kaptdWtimebus');        // 버스정류장까지
          info.convenient = f(d, 'convenientFacility'); // 편의시설
          info.education = f(d, 'educationFacility');   // 교육시설
          detailSrc = dep;
          // debug: 상세 응답의 모든 필드명 노출 (역명 필드 확인용)
          if (dbg && d && d.__xml === undefined) detailKeys = Object.keys(d);
          break;
        } catch (e) { /* 상세 실패해도 기본정보는 반환 */ }
      }

      res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate');
      return res.status(200).json(
        dbg ? { info, source: ep, detailSource: detailSrc, detailKeys } : { info, source: ep, detailSource: detailSrc }
      );
    }
    return res.status(502).json({ error: 'K-apt 단지정보 조회 실패', tried, hint: dbg ? undefined : '원인 확인은 URL 뒤에 &debug=1 을 붙여 다시 호출하세요.' });

  } catch (err) {
    return res.status(500).json({ error: '프록시 예외', detail: String(err) });
  }
}
