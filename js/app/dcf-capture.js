/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// DCF: 시킹알파 캡처(EPS 표·매출 표) 붙여 넣기와 글자 읽기(OCR)
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

// ---------- 1. 캡처 업로드 & 읽기 ----------
// 캡처 칸 2개: ① EPS 표, ② 매출 표. 칸마다 따로 읽고, 읽은 값은 아래 표 하나에 모읍니다.
let estimates = [];
const SLOT_KO = { eps: 'EPS 표', revenue: '매출 표' };
const slots = [...document.querySelectorAll('.drop[data-slot]')];
let pasteSlot = null; // 마지막으로 누르거나 가리킨 칸 (Ctrl+V 대상)

for (const drop of slots) {
  const input = drop.querySelector('input[type=file]');
  drop.addEventListener('click', () => { pasteSlot = drop; input.click(); });
  drop.addEventListener('focus', () => { pasteSlot = drop; });
  drop.addEventListener('mouseenter', () => { pasteSlot = drop; });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter') input.click(); });
  input.addEventListener('change', e => { if (e.target.files[0]) setImage(drop, e.target.files[0]); e.target.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const files = [...e.dataTransfer.files];
    if (files.some(x => x.type === 'application/pdf')) { handlePdfs(files); return; } // 재무제표 PDF를 여기 놓아도 처리
    const f = files.find(x => x.type.startsWith('image/'));
    if (f) setImage(drop, f);
  });
}
document.addEventListener('paste', e => {
  const item = [...(e.clipboardData || {}).items || []].find(x => x.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  // 칸을 누르거나 가리킨 적이 없으면 비어 있는 첫 칸에 넣음
  const target = pasteSlot || slots.find(d => !d.image) || slots[0];
  setImage(target, item.getAsFile());
});

function setImage(drop, blob) {
  const reader = new FileReader();
  reader.onload = () => {
    drop.image = { blob, dataUrl: reader.result };
    const img = drop.querySelector('.preview');
    img.src = reader.result;
    img.hidden = false;
    readSlot(drop); // 올리자마자 바로 읽음
  };
  reader.readAsDataURL(blob);
}

async function readSlot(drop) {
  const slot = drop.dataset.slot;
  const status = drop.parentElement.querySelector('.slot-status');
  try {
    let result;
    if (modeSel.value === 'claude') {
      status.textContent = 'Claude가 이미지를 읽는 중...';
      result = await readWithClaude(drop.image);
    } else {
      status.textContent = 'OCR 준비 중... (처음 한 번은 언어 데이터를 내려받느라 조금 걸립니다)';
      const text = await readWithTesseract(drop.image, p => { status.textContent = p; });
      result = SAParser.parseEstimates(text, slot);
      result.text = text;
    }
    // 이 칸에서 전에 읽은 값은 지우고 새로 읽은 값으로 바꿈
    const found = result.estimates.map(x => Object.assign({ use: true, slot }, x, { metric: x.metric || slot }));
    estimates = estimates.filter(e => e.slot !== slot && !found.some(f => f.metric === e.metric && f.year === e.year)).concat(found);
    renderEstimates((result.warnings || []).map(w => `${SLOT_KO[slot]}: ${w}`), result.text || '');
    const n = found.filter(e => e.metric === slot).length;
    status.textContent = n ? `${SAParser.METRIC_KO[slot]} ${n}개를 읽었습니다.` : found.length ? `읽었지만 ${SAParser.METRIC_KO[slot]} 표가 아닌 것 같습니다. 아래 표에서 확인하세요.` : '표를 읽지 못했습니다.';
    $('#ocr-status').textContent = estimates.length ? `추정치 ${estimates.length}개를 찾았습니다. 확인하고 "계산에 반영"을 누르세요.` : '';
  } catch (err) {
    console.error(err);
    status.textContent = '읽기 실패: ' + (err.message || err);
  }
}

// OCR 방식 선택
const modeSel = $('#ocr-mode');
function syncMode() {
  const claude = modeSel.value === 'claude';
  $('#key-wrap').hidden = !claude;
  $('#key-note').hidden = !claude;
}
modeSel.addEventListener('change', syncMode);
try { $('#api-key').value = localStorage.getItem(KEY_STORE) || ''; } catch (e) { /* ignore */ }
$('#api-key').addEventListener('change', e => { try { localStorage.setItem(KEY_STORE, e.target.value.trim()); } catch (x) { /* ignore */ } });

// 스크린샷 전처리: 확대 + 흑백 + (다크모드면) 반전 → Tesseract 인식률 개선
function preprocess(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(3, Math.max(1, 2000 / img.width));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) {
        const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        px[i] = px[i + 1] = px[i + 2] = y;
        sum += y;
      }
      if (sum / (px.length / 4) < 128) for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
      ctx.putImageData(d, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('이미지를 열 수 없습니다.'));
    img.src = dataUrl;
  });
}

let workerPromise = null;
let ocrProgress = () => {}; // 지금 읽고 있는 칸의 진행 표시
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: CDN + 'tesseract.js@5.1.1/dist/worker.min.js',
      corePath: CDN + 'tesseract.js-core@5.1.1',
      langPath: CDN + '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
      logger: m => {
        if (m.status && typeof m.progress === 'number') ocrProgress(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`);
      },
    }).then(async w => {
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      return w;
    });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

async function readWithTesseract(image, onProgress) {
  const canvas = await preprocess(image.dataUrl);
  ocrProgress = onProgress;
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  ocrProgress = () => {};
  return data.text;
}

async function readWithClaude(image) {
  const key = $('#api-key').value.trim();
  if (!key) throw new Error('Anthropic API 키를 넣어주세요.');
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(image.dataUrl);
  if (!m) throw new Error('이미지 형식을 읽을 수 없습니다.');
  const schema = {
    type: 'object',
    properties: {
      estimates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            metric: { type: 'string', enum: ['revenue', 'ebit', 'ebitda', 'capex'] },
            period_label: { type: 'string' },
            fiscal_year: { type: 'integer' },
            value_millions_usd: { type: 'number' },
          },
          required: ['metric', 'period_label', 'fiscal_year', 'value_millions_usd'],
          additionalProperties: false,
        },
      },
      note: { type: 'string' },
    },
    required: ['estimates', 'note'],
    additionalProperties: false,
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          {
            type: 'text',
            text: 'This is a Seeking Alpha "Earnings Estimates" screenshot. Extract the annual consensus estimates for Revenue, EBIT, ' +
              'EBITDA and Capital Expenditure tables that are visible (the estimate column, not EPS, not Low/High). ' +
              'For each value give the metric, the fiscal period label as shown, ' +
              'the fiscal year (the calendar year in which the fiscal period ends), and the value converted to millions of USD ' +
              '(e.g. 614.82B -> 614820, 950.3M -> 950.3). If something is unclear or the table is quarterly, say so in note (in Korean).',
          },
        ],
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error && body.error.message) || 'HTTP ' + res.status);
  if (body.stop_reason === 'refusal') throw new Error('Claude가 요청을 처리하지 않았습니다.');
  const textBlock = (body.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('응답에 결과가 없습니다.');
  const parsed = JSON.parse(textBlock.text);
  return {
    estimates: parsed.estimates.map(x => ({ metric: x.metric, year: x.fiscal_year, label: x.period_label, value: x.value_millions_usd, raw: 'Claude' })),
    warnings: parsed.note ? [parsed.note] : [],
    text: textBlock.text,
  };
}

function slotFor(year) {
  const t = year - state.baseFY;
  return t >= 1 && t <= 5 ? t : null;
}

function renderEstimates(warnings, text) {
  $('#est-wrap').hidden = false;
  // 0년차 회계연도가 추정치와 안 맞으면 첫 추정치 직전 해로 맞춰 줌
  if (estimates.length && !estimates.some(e => slotFor(e.year))) {
    state.baseFY = Math.min(...estimates.map(e => e.year)) - 1;
    warnings = warnings.concat(`0년차 회계연도를 FY${state.baseFY}로 바꿨습니다 (첫 추정치 바로 전 해). 다르면 '자세히 보기'에서 고치세요.`);
    recalc();
  }
  $('#warnings').innerHTML = warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('');
  $('#ocr-text').textContent = text;
  drawEstRows();
}

function drawEstRows() {
  $('#est-table tbody').innerHTML = estimates.map((e, i) => {
    const t = slotFor(e.year);
    return `<tr>
        <td><input type="checkbox" data-e="use" data-i="${i}" ${e.use ? 'checked' : ''}></td>
        <td><select data-e="metric" data-i="${i}">${Object.entries(SAParser.METRIC_KO).map(([k, l]) => `<option value="${k}"${(e.metric || 'revenue') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
        <td>${esc(e.label)}</td>
        <td><input data-e="year" data-i="${i}" type="number" value="${e.year}" style="width:76px"></td>
        <td class="muted">${esc(e.raw)}</td>
        <td><input class="wide" data-e="value" data-i="${i}" type="number" step="any" value="${+e.value.toFixed(2)}"></td>
        <td>${t ? t + '년차 (FY' + e.year + ')' + (t > MAX_YEARS ? ' <span class="muted small">내년·내후년용</span>' : '') : '<span class="muted">범위 밖</span>'}</td>
      </tr>`;
  }).join('');
}

$('#est-table').addEventListener('input', e => {
  const { e: field, i } = e.target.dataset;
  if (!field) return;
  const row = estimates[+i];
  if (field === 'use') row.use = e.target.checked;
  else if (field === 'metric') row.metric = e.target.value;
  else if (field === 'year') { row.year = parseInt(e.target.value, 10) || row.year; drawEstRows(); }
  else row.value = parseFloat(e.target.value) || 0;
});
$('#btn-add-row').addEventListener('click', () => {
  const last = estimates.length ? estimates[estimates.length - 1].year : state.baseFY;
  estimates.push({ use: true, metric: 'revenue', year: last + 1, label: '직접 입력', raw: '', value: 0 });
  drawEstRows();
});
$('#btn-apply').addEventListener('click', () => {
  const n = {}, raw = state.estRaw || (state.estRaw = {});
  let maxT = 0;
  for (const e of estimates) {
    const t = slotFor(e.year), m = e.metric || 'revenue';
    if (!e.use || !t || !e.value) continue;
    if (m === 'revenue') {
      if (e.value <= 0) continue;
      state.revenue[t] = e.value; if (state.revAssumed) state.revAssumed[t] = false; maxT = Math.max(maxT, t);
    } else (raw[m] = raw[m] || {})[e.year] = e.value;
    n[m] = (n[m] || 0) + 1;
  }
  // 예측 기간 = 매출 추정치가 있는 마지막 해
  if (maxT) state.horizon = Math.min(MAX_YEARS, maxT); // 5년치를 넣어도 3년까지만 계산 (4~5년차는 내년·내후년 적정가에 씀)
  applyMetricEstimates(state);
  basicRefresh(state);
  renderBasicForm();
  recalc();
  const done = Object.entries(n).map(([m, c]) => `${SAParser.METRIC_KO[m]} ${c}개`).join(', ');
  $('#ocr-status').textContent = done ? `${done}를 넣었습니다.` : '넣을 값이 없습니다.';
  $('#hero').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
