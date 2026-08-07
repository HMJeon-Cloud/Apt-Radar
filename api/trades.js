// /api/trades?lawd=43113&ym=202606&kind=sale
// /api/trades?lawd=43113&ym=202606&kind=rent
// 국토교통부 아파트 매매 상세 + 전월세 실거래가 프록시 v0.3
// kind=sale → RTMSDataSvcAptTradeDev (해제여부/거래유형 포함)
// kind=rent → RTMSDataSvcAptRent     (보증금/월세/전세 구분)

const EP = {
  sale: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev',
  rent: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent'
};

function pick(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}
function toInt(s){ return parseInt(String(s).replace(/,/g, ''), 10) || 0; }

export default async function handler(req, res) {
  const { lawd, ym } = req.query;
  const kind = req.query.kind === 'rent' ? 'rent' : 'sale';

  if (!/^\d{5}$/.test(lawd || '') || !/^\d{6}$/.test(ym || '')) {
    return res.status(400).json({ error: 'lawd(5자리), ym(YYYYMM) 파라미터가 필요합니다.' });
  }
  const rawKey = process.env.MOLIT_API_KEY;
  if (!rawKey) {
    return res.status(500).json({ error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  const raw = rawKey.trim();
  const key = raw.includes('%') ? raw : encodeURIComponent(raw); // 이중 인코딩 방지

  const url = EP[kind]
    + '?serviceKey=' + key
    + '&LAWD_CD=' + lawd
    + '&DEAL_YMD=' + ym
    + '&pageNo=1&numOfRows=1000';

  try {
    const r = await fetch(url);
    const xml = await r.text();

    const authErr = pick(xml, 'returnReasonCode');
    if (authErr) {
      return res.status(502).json({
        error: '공공데이터포털 인증/공통 오류', kind,
        code: authErr, msg: pick(xml, 'returnAuthMsg') || pick(xml, 'errMsg')
      });
    }
    const resultCode = pick(xml, 'resultCode');
    if (resultCode && resultCode !== '000' && resultCode !== '00') {
      return res.status(502).json({ error: 'MOLIT API 오류', kind, code: resultCode, msg: pick(xml, 'resultMsg') });
    }

    const items = [];
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const b of blocks) {
      const y = parseInt(pick(b, 'dealYear'), 10);
      const m = parseInt(pick(b, 'dealMonth'), 10);
      const base = {
        ym: y * 100 + m,
        day: parseInt(pick(b, 'dealDay'), 10) || 1,
        apt: pick(b, 'aptNm'),
        aptSeq: pick(b, 'aptSeq'),
        dong: pick(b, 'umdNm'),
        area: parseFloat(pick(b, 'excluUseAr')) || 0,
        floor: parseInt(pick(b, 'floor'), 10) || 0,
        buildYear: parseInt(pick(b, 'buildYear'), 10) || null
      };
      if (kind === 'sale') {
        const cdealType = pick(b, 'cdealType'); // "O" = 해제
        // 도로명 주소 조립: 본번(00029)+부번(00000) → "29" 또는 "29-3"
        const rBon = parseInt(pick(b, 'roadNmBonbun'), 10) || 0;
        const rBub = parseInt(pick(b, 'roadNmBubun'), 10) || 0;
        const roadNm = pick(b, 'roadNm');
        const roadNo = rBon ? (rBub ? rBon + '-' + rBub : String(rBon)) : '';
        items.push(Object.assign(base, {
          amount: toInt(pick(b, 'dealAmount')), // 만원
          dealing: pick(b, 'dealingGbn'),
          canceled: cdealType === 'O',
          cancelDay: pick(b, 'cdealDay'),
          rgstDate: pick(b, 'rgstDate'),
          sggNm: pick(b, 'estateAgentSggNm'),      // 예: 충북 청주시 흥덕구
          roadAddr: roadNm ? (roadNm + (roadNo ? ' ' + roadNo : '')) : '', // 예: 송화로214번길 29
          jibun: pick(b, 'jibun')                   // 예: 850
        }));
      } else {
        const monthly = toInt(pick(b, 'monthlyRent'));
        items.push(Object.assign(base, {
          deposit: toInt(pick(b, 'deposit')),   // 만원
          monthly: monthly,                      // 만원, 0이면 전세
          jeonse: monthly === 0,                 // 전세 여부
          contractType: pick(b, 'contractType')  // 신규/갱신 (있을 때)
        }));
      }
    }

    const body = { lawd, ym, kind, count: items.length, items };
    if (items.length === 0) {
      body.diag = {
        httpStatus: r.status,
        resultCode: resultCode || '(없음)',
        totalCount: pick(xml, 'totalCount') || '(없음)',
        xmlHead: xml.slice(0, 300).replace(/serviceKey=[^&"<]*/g, 'serviceKey=***')
      };
    }

    // 확정월(2개월 이전)은 데이터가 사실상 불변 → 길게, 최근월은 신규 신고 반영 위해 짧게
    const now = new Date();
    const curYm = now.getFullYear() * 100 + (now.getMonth() + 1);
    const reqYm = parseInt(ym, 10);
    const monthsAgo = (Math.floor(curYm/100) - Math.floor(reqYm/100)) * 12 + (curYm%100 - reqYm%100);
    res.setHeader('Cache-Control', monthsAgo >= 2
      ? 's-maxage=2592000, stale-while-revalidate=86400'
      : 's-maxage=10800, stale-while-revalidate=3600');
    return res.status(200).json(body);
  } catch (e) {
    return res.status(502).json({ error: '프록시 요청 실패', kind, detail: String(e) });
  }
}
