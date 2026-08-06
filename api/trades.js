// /api/trades?lawd=43113&ym=202606
// 국토교통부 아파트 매매 실거래가 API 프록시 v0.1.1
// 변경점: 0건일 때 원인 진단 정보(diag) 포함, 공공데이터포털 공통 오류 형식(cmmMsgHeader) 감지 추가

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
  const rawKey = process.env.MOLIT_API_KEY;
  if (!rawKey) {
    return res.status(500).json({ error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다.' });
  }
  const key = rawKey.trim(); // 앞뒤 공백/줄바꿈 제거

  const url = ENDPOINT
    + '?serviceKey=' + encodeURIComponent(key)
    + '&LAWD_CD=' + lawd
    + '&DEAL_YMD=' + ym
    + '&pageNo=1&numOfRows=1000';

  try {
    const r = await fetch(url);
    const xml = await r.text();

    // 1) 공공데이터포털 공통 오류 형식 (인증 실패 등은 이 형식으로 옴)
    const authErr = pick(xml, 'returnReasonCode');
    if (authErr) {
      return res.status(502).json({
        error: '공공데이터포털 인증/공통 오류',
        code: authErr,
        msg: pick(xml, 'returnAuthMsg') || pick(xml, 'errMsg')
      });
    }

    // 2) 국토부 API 자체 오류 형식
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

    const body = { lawd, ym, count: items.length, items };

    // 3) 0건이면 판단 근거를 함께 반환 (실제 거래 0건인지, 응답 이상인지 구분용)
    if (items.length === 0) {
      body.diag = {
        httpStatus: r.status,
        resultCode: resultCode || '(없음)',
        resultMsg: pick(xml, 'resultMsg') || '(없음)',
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
