/* global DCF, SAParser, SAPdf, Tesseract, ExcelJS */
// 첫 화면 열기 (반드시 맨 마지막에 불러옴)
// js/app/ 파일들은 한 화면 코드를 기능별로 나눈 것. index.html 에 적힌 순서대로 불러오고, 서로의 이름(함수·변수)을 그대로 씀.
'use strict';

syncMode();
renderAll();
if (state.info && state.info.history) renderHistory(state.info);
const qs = new URLSearchParams(location.search), qt = qs.get('t');
if (qt) { markTab('dcf'); lookup(qt); }
// 첫 화면은 차트 (주소에 ?t= 가 있거나 마지막에 DCF 탭을 봤으면 DCF)
else if (!/[?&]kakao=ok/.test(location.search) && lsGet(TAB_KEY, 'chart') !== 'dcf') openModal();
else if ($('#chart-modal').hidden) markTab('dcf');
