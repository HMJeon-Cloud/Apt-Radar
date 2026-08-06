// /api/trades?lawd=43113&ym=202606
// 국토교통부 아파트 매매 실거래가 "상세" API 프록시 v0.2
// 엔드포인트: RTMSDataSvcAptTradeDev (해제여부/거래유형/등기일자 포함)

const ENDPOINT = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';

function pick(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

export default async function handler(req, res) {
  const { lawd, ym } = req.query;

  if (!/^\d{5}$/.test(lawd || '') || !/^\d{6}$/.test(ym || '')) {
    return res.status(400).json({ error: 'lawd(5자리), ym(YYYYMM) 파라미터가 필요합니다.' });
  }
  const rawKey = process.env.MOLIT_API_KEY;
  if (!rawKey) {
    return res.status(500).json({ error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  // Decoding 키(%없음)면 인코딩, Encoding 키(%포함)면 그대로 → 이중 인코딩 방지
  const raw = rawKey.trim();
  const key = raw.includes('%') ? raw : encodeURIComponent(raw);

  const url = ENDPOINT
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
        error: '공공데이터포털 인증/공통 오류',
        code: authErr,
        msg: pick(xml, 'returnAuthMsg') || pick(xml, 'errMsg')
      });
    }
    const resultCode = pick(xml, 'resultCode');
    if (resultCode && resultCode !== '000' && resultCode !== '00') {
      return res.status(502).json({ error: 'MOLIT API 오류', code: resultCode, msg: pick(xml, 'resultMsg') });
    }

    const items = [];
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const b of blocks) {
      const y = parseInt(pick(b, 'dealYear'), 10);
      const m = parseInt(pick(b, 'dealMonth'), 10);
      const cdealType = pick(b, 'cdealType'); // "O" = 해제(취소)됨, 공백 = 정상
      items.push({
        ym: y * 100 + m,
        day: parseInt(pick(b, 'dealDay'), 10) || 1,
        apt: pick(b, 'aptNm'),
        aptSeq: pick(b, 'aptSeq'),       // 단지 식별자 (43113-521)
        dong: pick(b, 'umdNm'),
        area: parseFloat(pick(b, 'excluUseAr')) || 0,
        floor: parseInt(pick(b, 'floor'), 10) || 0,
        amount: parseInt(pick(b, 'dealAmount').replace(/,/g, ''), 10) || 0, // 만원
        buildYear: parseInt(pick(b, 'buildYear'), 10) || null,
        dealing: pick(b, 'dealingGbn'),  // 중개거래/직거래
        canceled: cdealType === 'O',     // 취소 여부
        cancelDay: pick(b, 'cdealDay'),  // 해제일
        rgstDate: pick(b, 'rgstDate')    // 등기일자
      });
    }

    const body = { lawd, ym, count: items.length, items };
    if (items.length === 0) {
      body.diag = {
        httpStatus: r.status,
        resultCode: resultCode || '(없음)',
        totalCount: pick(xml, 'totalCount') || '(없음)',
        xmlHead: xml.slice(0, 300).replace(/serviceKey=[^&"<]*/g, 'serviceKey=***')
      };
    }

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json(body);
  } catch (e) {
    return res.status(502).json({ error: '프록시 요청 실패', detail: String(e) });
  }
}
