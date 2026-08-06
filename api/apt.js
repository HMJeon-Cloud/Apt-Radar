// /api/apt?kind=list&lawd=41593        → 시군구 내 K-apt 단지 목록 (kaptCode, kaptName, 주소)
// /api/apt?kind=info&kapt=A10027875    → 단지 기본정보 (세대수/동수/주차/난방/사용승인일 등)
//
// 국토교통부_공동주택 기본/목록 정보제공 서비스 프록시
// 엔드포인트가 기관코드(1613000 V3 / 1611000 구버전)로 갈라져 있어 순차 폴백한다.

// info가 V4(getAphusBassInfoV4)로 성공 → 목록도 유사 패턴 예상.
// 서비스 버전(4/3/2/무)과 오퍼레이션 접미어(4/3/2/무) 조합을 넓게 시도.
const LIST_EPS = (function(){
  var out = [];
  var svcVers = ['4', '3', '2', ''];
  var opVers  = ['4', '3', '2', ''];
  svcVers.forEach(function(sv){
    opVers.forEach(function(ov){
      out.push({
        url: 'https://apis.data.go.kr/1613000/AptListService' + sv + '/getSigunguAptList' + ov,
        param: 'sigunguCode'
      });
    });
  });
  // 구버전 기관코드도 마지막에
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

// 인증/공통 오류면 문자열 반환, 정상이면 null
function errOf(xml){
  const authErr = pick(xml, 'returnReasonCode');
  if (authErr) return 'auth:' + authErr + ':' + (pick(xml, 'returnAuthMsg') || pick(xml, 'errMsg'));
  const rc = pick(xml, 'resultCode');
  if (rc && rc !== '000' && rc !== '00') return 'api:' + rc + ':' + pick(xml, 'resultMsg');
  return null;
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
          + '&pageNo=1&numOfRows=1000';
        let xml = '';
        try {
          const r = await fetch(url);
          xml = await r.text();
        } catch (e) {
          tried.push({ ep: ep.url, err: String(e) });
          continue;
        }
        const e = errOf(xml);
        if (e){
          tried.push(debug ? { url: url.replace(key, 'KEY'), err: e, raw: xml.slice(0, 300) } : { ep: ep.url, err: e });
          continue;
        }

        const items = [];
        // V4 목록도 <item> 단위로 반복. 없으면 빈 배열.
        const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        for (const b of blocks) {
          var code = pick(b, 'kaptCode');
          if (!code) continue;
          items.push({
            kaptCode: code,
            name: pick(b, 'kaptName'),
            bjdCode: pick(b, 'bjdCode'),
            addr: [pick(b,'as1'), pick(b,'as2'), pick(b,'as3'), pick(b,'as4')].filter(Boolean).join(' ')
          });
        }
        if (items.length) {
          res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
          return res.status(200).json({ count: items.length, items, source: ep.url });
        }
        tried.push(debug ? { ep: ep.url, err: 'empty', raw: xml.slice(0, 500) } : { ep: ep.url, err: 'empty' });
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
      const url = ep + '?serviceKey=' + key + '&kaptCode=' + encodeURIComponent(kapt);
      let xml = '';
      try {
        const r = await fetch(url);
        xml = await r.text();
      } catch (e) {
        tried.push({ ep, err: String(e) });
        continue;
      }
      const e = errOf(xml);
      if (e){ tried.push(dbg ? { ep, err: e, raw: xml.slice(0,500) } : { ep, err: e }); continue; }

      // V4는 <response><body><item>…</item></body></response> 로 한 번 더 감싼다.
      // <item> 블록이 있으면 그 안에서, 없으면 전체에서 필드를 뽑는다.
      const itemBlock = (xml.match(/<item>[\s\S]*?<\/item>/) || [xml])[0];
      if (!pick(itemBlock, 'kaptCode')){
        tried.push(dbg ? { ep, err: 'empty', raw: xml.slice(0,500) } : { ep, err: 'empty' });
        continue;
      }
      const src = itemBlock;

      const info = {
        kaptCode: pick(src, 'kaptCode'),
        name: pick(src, 'kaptName'),
        addr: pick(src, 'kaptAddr'),
        roadAddr: pick(src, 'doroJuso'),
        households: toInt(pick(src, 'kaptdaCnt')),      // 세대수
        dongCnt: toInt(pick(src, 'kaptDongCnt')),        // 동수
        useDate: pick(src, 'kaptUsedate'),               // 사용승인일 (YYYYMMDD)
        heat: pick(src, 'codeHeatNm'),                   // 난방방식
        hall: pick(src, 'codeHallNm'),                   // 복도유형
        saleType: pick(src, 'codeSaleNm'),               // 분양형태
        builder: pick(src, 'kaptBcompany'),              // 시공사
        totalArea: toNum(pick(src, 'kaptTarea'))         // 연면적
      };

      // 상세정보(주차·지하철·편의시설) 병합 시도 — 같은 kaptCode
      let detailSrc = 'none';
      for (const dep of DETAIL_EPS) {
        try {
          const dr = await fetch(dep + '?serviceKey=' + key + '&kaptCode=' + encodeURIComponent(kapt));
          const dxml = await dr.text();
          if (errOf(dxml)) continue;
          const dblock = (dxml.match(/<item>[\s\S]*?<\/item>/) || [dxml])[0];
          if (!pick(dblock, 'kaptCode')) continue;
          info.parkingTotal = toInt(pick(dblock, 'kaptdPcnt')) + toInt(pick(dblock, 'kaptdPcntu')); // 지상+지하
          info.cctv = toInt(pick(dblock, 'kaptdCccnt'));
          info.subwayLine = pick(dblock, 'subwayLine');       // 지하철호선
          info.subwayStation = pick(dblock, 'subwayStation'); // 지하철역명
          info.subwayWay = pick(dblock, 'kaptdWtimesub');     // 지하철역까지 소요(도보 분) 또는 거리
          info.busWay = pick(dblock, 'kaptdWtimebus');        // 버스정류장까지
          info.convenient = pick(dblock, 'convenientFacility'); // 편의시설
          info.education = pick(dblock, 'educationFacility');   // 교육시설
          detailSrc = dep;
          break;
        } catch (e) { /* 상세 실패해도 기본정보는 반환 */ }
      }

      res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate');
      return res.status(200).json({ info, source: ep, detailSource: detailSrc });
    }
    return res.status(502).json({ error: 'K-apt 단지정보 조회 실패', tried, hint: dbg ? undefined : '원인 확인은 URL 뒤에 &debug=1 을 붙여 다시 호출하세요.' });

  } catch (err) {
    return res.status(500).json({ error: '프록시 예외', detail: String(err) });
  }
}
