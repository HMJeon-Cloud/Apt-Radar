// /api/trades?lawd=43113&ym=202607
// 국토교통부 아파트 매매 실거래가 API 프록시 (Vercel Serverless Function)
// 환경변수 MOLIT_API_KEY 필요 (공공데이터포털 일반 인증키 - Decoding 키 사용)

const ENDPOINT = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';

function pick(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

export default async function handler(req, res) {
  const { lawd, ym } = req.query;

  if (!/^\d{5}$/.test(lawd || '') || !/^\d{6}$/.test(ym || '')) {
    return res.status(400).json({ error: 'lawd(5자리), ym(YYYYMM) 파라미터가 필요합니다.' });
  }
  const key = process.env.MOLIT_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const url = ENDPOINT
    + '?serviceKey=' + encodeURIComponent(key)
    + '&LAWD_CD=' + lawd
    + '&DEAL_YMD=' + ym
    + '&pageNo=1&numOfRows=1000';

  try {
    const r = await fetch(url);
    const xml = await r.text();

    const resultCode = pick(xml, 'resultCode');
    if (resultCode && resultCode !== '000' && resultCode !== '00') {
      return res.status(502).json({ error: 'MOLIT API 오류', code: resultCode, msg: pick(xml, 'resultMsg') });
    }

    const items = [];
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const b of blocks) {
      const amountRaw = pick(b, 'dealAmount').replace(/,/g, '');
      const y = parseInt(pick(b, 'dealYear'), 10);
      const m = parseInt(pick(b, 'dealMonth'), 10);
      items.push({
        ym: y * 100 + m,
        day: parseInt(pick(b, 'dealDay'), 10) || 1,
        apt: pick(b, 'aptNm'),
        dong: pick(b, 'umdNm'),
        area: parseFloat(pick(b, 'excluUseAr')) || 0,
        floor: parseInt(pick(b, 'floor'), 10) || 0,
        amount: parseInt(amountRaw, 10) || 0, // 단위: 만원
        buildYear: parseInt(pick(b, 'buildYear'), 10) || null
      });
    }

    // 과거 월 데이터는 사실상 확정이므로 CDN 캐시 (하루)
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({ lawd, ym, count: items.length, items });
  } catch (e) {
    return res.status(502).json({ error: '프록시 요청 실패', detail: String(e) });
  }
}
