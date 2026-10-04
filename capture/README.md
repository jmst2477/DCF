# 시킹알파 캡처 → DCF 계산기 (`capture/`)

시킹알파 **Earnings → Estimates** 화면(Annual, Revenue Estimates 표)을 캡처해 올리면
연도별 매출 추정치를 읽어 10년 DCF에 넣고, 1주당 내재가치를 계산하는 정적 웹페이지입니다.

- 캡처 읽기: 브라우저 OCR(Tesseract.js, 무료) 또는 Claude API(API 키 필요, 더 정확)
- 읽은 숫자는 표에서 고친 뒤 넣을 수 있습니다.
- 계산식은 「DCF 개선판 v2」 엑셀과 같습니다 (연도별 이익률·감가상각비·캐펙스, 6~10년차 감속, 정상화 영구가치, 차입금 부호 수정).
- "엑셀 다운로드"는 같은 셀 배치·수식의 .xlsx를 만듭니다.
- 입력값은 브라우저(localStorage)에만 저장됩니다.
- "티커로 불러오기"는 같은 저장소의 `/api/financials`(Vercel 함수)를 씁니다. GitHub Pages에서는 동작하지 않으니 직접 입력하세요.

## 파일
- `index.html` 화면
- `js/dcf.js` DCF 계산 (엑셀 수식과 1:1)
- `js/parser.js` OCR 글자 → 연도별 매출 추정치
- `js/app.js` 화면 동작, OCR, Claude API, 엑셀 내보내기
- `css/style.css`
