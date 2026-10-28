// 관심종목 테마 자동 분류
// 1) 아래 사전에 있는 종목은 그 테마로 (리포트에서 자주 묶이는 산업 기준)
// 2) 사전에 없으면 야후 업종(/api/prices 의 profile)을 한글 테마로 바꿔서
// 사용자가 직접 바꾸거나 뺀 테마는 다시 덮어쓰지 않습니다 (js/app.js).
(function () {
  const BOOK = {
    '전력': 'GEV BE CEG CAT ETN PWR VRT FIX VST NRG TLN OKLO SMR NNE LEU CCJ UEC NXE BWXT NEE SO DUK AEP D EXC XEL ETR PCG EIX SRE PEG ED AES HUBB MOD NVT POWL AMSC EME MTZ PRIM MYRG ENPH FSLR SEDG RUN PLUG URA NLR',
    '우주': 'RKLB ASTS LUNR PL RDW SPCE IRDM SATS BKSY GSAT VSAT FLY VOYG MNTS UFO ARKX',
    '방산': 'LMT NOC RTX GD LHX HII KTOS AVAV LDOS BAH ITA XAR',
    '반도체': 'NVDA AMD AVGO TSM INTC MU QCOM TXN ADI MRVL ARM ASML AMAT LRCX KLAC ON NXPI MCHP SMTC ALAB CRDO COHR LITE MPWR TER ENTG SNPS CDNS GFS WOLF SWKS QRVO SMH SOXX SOXL',
    '빅테크': 'AAPL MSFT GOOGL GOOG AMZN META NFLX',
    '소프트웨어': 'PLTR CRM ORCL NOW ADBE SNOW DDOG MDB SHOP INTU WDAY TEAM APP HUBS U PATH AI IGV',
    '사이버보안': 'CRWD PANW ZS FTNT NET OKTA S CYBR CIBR HACK',
    '양자컴퓨터': 'IONQ RGTI QBTS QUBT',
    '전기차': 'TSLA RIVN LCID NIO XPEV LI',
    '바이오·헬스케어': 'LLY NVO UNH JNJ PFE MRK ABBV AMGN VRTX REGN ISRG TMO GILD BMY HIMS XBI XLV',
    '금융': 'JPM BAC GS MS V MA C WFC AXP SCHW BLK HOOD SOFI PYPL BRK-B BRK.B XLF',
    '암호화폐': 'COIN MSTR MARA RIOT CLSK IBIT ETHA',
    '석유·가스': 'XOM CVX COP OXY SLB EOG HAL XLE',
    '지수 ETF': 'SPY QQQ VOO IVV VTI DIA IWM QQQM SCHD TQQQ SPLG',
  };
  const MAP = {};
  Object.keys(BOOK).forEach(th => BOOK[th].split(' ').forEach(t => { MAP[t] = th; }));

  // 야후 업종 → 테마 (앞에서부터 먼저 맞는 것)
  const INDUSTRY = [
    [/semiconductor/i, '반도체'],
    [/uranium|utilities|solar|electrical equipment/i, '전력'],
    [/aerospace|defense/i, '방산'],
    [/software|information technology services/i, '소프트웨어'],
    [/biotech|drug|medical|diagnostics|health/i, '바이오·헬스케어'],
    [/bank|capital markets|credit|insurance|asset management|financial/i, '금융'],
    [/oil|gas/i, '석유·가스'],
    [/auto/i, '자동차'],
  ];
  const SECTOR = {
    'Technology': '기술', 'Industrials': '산업재', 'Consumer Cyclical': '소비재', 'Consumer Defensive': '필수소비재',
    'Healthcare': '바이오·헬스케어', 'Financial Services': '금융', 'Energy': '석유·가스', 'Utilities': '전력',
    'Real Estate': '부동산', 'Basic Materials': '소재', 'Communication Services': '통신·미디어',
  };

  function guess(ticker, profile) {
    if (MAP[ticker]) return MAP[ticker];
    if (!profile) return null;
    const ind = profile.industry || '';
    for (const [re, th] of INDUSTRY) if (re.test(ind)) return th;
    return SECTOR[profile.sector] || null;
  }

  window.THEMES = { guess, known: t => !!MAP[t] };
})();
