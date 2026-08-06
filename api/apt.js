// /api/apt?kind=list&lawd=41593        → 시군구 내 K-apt 단지 목록 (kaptCode, kaptName, 주소)
// /api/apt?kind=info&kapt=A10027875    → 단지 기본정보 (세대수/동수/주차/난방/사용승인일 등)
//
// 국토교통부_공동주택 기본/목록 정보제공 서비스 프록시
// 엔드포인트가 기관코드(1613000 V3 / 1611000 구버전)로 갈라져 있어 순차 폴백한다.

// 오퍼레이션 이름/기관코드 조합이 문서마다 달라 순차 폴백한다.
// (실사용 확인된 형태: AptListService2/getSigunguAptList?sigunguCode=)
const LIST_EPS = [
  { url: 'https://apis.data.go.kr/1613000/AptListService3/getSigunguAptList',  param: 'sigunguCode' },
  { url: 'https://apis.data.go.kr/1613000/AptListService2/getSigunguAptList',  param: 'sigunguCode' },
  { url: 'https://apis.data.go.kr/1613000/AptListService3/getSigunguAptList3', param: 'sigunguCode' },
  { url: 'https://apis.data.go.kr/1613000/AptListService2/getSigunguAptList2', param: 'sigunguCode' },
  { url: 'https://apis.data.go.kr/1611000/AptListService/getSigunguAptList',   param: 'sigunguCode' },
  { url: 'https://apis.data.go.kr/1613000/AptListService/getSigunguAptList',   param: 'sigunguCode' }
];

const INFO_EPS = [
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusBassInfoV2',
  'https://apis.data.go.kr/1613000/AptBasisInfoService/getAphusBassInfo',
  'https://apis.data.go.kr/1611000/AptBasisInfoService/getAphusBassInfo'
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
          tried.push(debug ? { ep: ep.url, err: e, raw: xml.slice(0, 500) } : { ep: ep.url, err: e });
          continue;
        }

        const items = [];
        const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        for (const b of blocks) {
          items.push({
            kaptCode: pick(b, 'kaptCode'),
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
      if (!pick(xml, 'kaptCode')){
        tried.push(dbg ? { ep, err: 'empty', raw: xml.slice(0,500) } : { ep, err: 'empty' });
        continue;
      }

      const info = {
        kaptCode: pick(xml, 'kaptCode'),
        name: pick(xml, 'kaptName'),
        addr: pick(xml, 'kaptAddr'),
        roadAddr: pick(xml, 'doroJuso'),
        households: toInt(pick(xml, 'kaptdaCnt')),      // 세대수
        dongCnt: toInt(pick(xml, 'kaptDongCnt')),        // 동수
        useDate: pick(xml, 'kaptUsedate'),               // 사용승인일 (YYYYMMDD)
        heat: pick(xml, 'codeHeatNm'),                   // 난방방식
        hall: pick(xml, 'codeHallNm'),                   // 복도유형
        saleType: pick(xml, 'codeSaleNm'),               // 분양형태
        builder: pick(xml, 'kaptBcompany'),              // 시공사
        totalArea: toNum(pick(xml, 'kaptTarea')),        // 연면적
        // 아래는 상세(detail) 오퍼레이션에만 있을 수 있어 없으면 0
        parkingTotal: toInt(pick(xml, 'kaptdPcnt')) + toInt(pick(xml, 'kaptdPcntu')),
        cctv: toInt(pick(xml, 'kaptdCccnt'))
      };
      res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate');
      return res.status(200).json({ info, source: ep });
    }
    return res.status(502).json({ error: 'K-apt 단지정보 조회 실패', tried, hint: dbg ? undefined : '원인 확인은 URL 뒤에 &debug=1 을 붙여 다시 호출하세요.' });

  } catch (err) {
    return res.status(500).json({ error: '프록시 예외', detail: String(err) });
  }
}
