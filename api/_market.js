// 미국 증시(NYSE·나스닥) 휴장일. 거래소가 공개한 고정 규칙으로 계산한다 (한투 "해외결제일자조회"는 결제일만 줘서 휴장 판단에 쓰기 애매함).
// 새해·마틴 루서 킹·대통령의 날·성금요일·메모리얼·준틴스·독립기념일·노동절·추수감사절·성탄절. 주말이면 금/월로 옮긴다.
// (조기 폐장일은 장이 열리므로 휴장으로 보지 않는다)

const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
// n 번째 요일 (wd: 0=일 … 6=토), n<0 이면 끝에서
function nth(y, m, wd, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return iso(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lw = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return iso(y, m, lastDay - ((lw - wd + 7) % 7));
}
// 토요일이면 금요일, 일요일이면 월요일로
function observed(y, m, d) {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 6 ? iso(y, m, d - 1) : wd === 0 ? iso(y, m, d + 1) : iso(y, m, d);
}
// 부활절 (그레고리력, Anonymous 알고리즘)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}

const cache = {};
export function usHolidays(y) {
  if (cache[y]) return cache[y];
  const list = {
    [observed(y, 1, 1)]: "새해",
    [nth(y, 1, 1, 3)]: "마틴 루서 킹의 날",
    [nth(y, 2, 1, 3)]: "대통령의 날",
    [new Date(easter(y) - 2 * 864e5).toISOString().slice(0, 10)]: "성금요일",
    [nth(y, 5, 1, -1)]: "메모리얼 데이",
    [nth(y, 9, 1, 1)]: "노동절",
    [nth(y, 11, 4, 4)]: "추수감사절",
    [observed(y, 12, 25)]: "성탄절",
  };
  if (y >= 2022) list[observed(y, 6, 19)] = "준틴스";
  list[observed(y, 7, 4)] = "독립기념일";
  // 1월 1일이 토요일이면 전년 12/31 금요일은 휴장하지 않는다 (NYSE 규칙)
  delete list[iso(y - 1, 12, 31)];
  return (cache[y] = list);
}

// "YYYY-MM-DD" 가 미국 휴장(주말 포함)이면 이유, 아니면 null
export function usClosed(day) {
  const wd = new Date(day + "T12:00:00Z").getUTCDay();
  if (wd === 0 || wd === 6) return "주말";
  return usHolidays(Number(day.slice(0, 4)))[day] || null;
}

// 지금 넣는 예약 주문이 나가는 미국 장의 날짜: 한국 날짜 그대로 (한국 밤 23:30/22:30 = 미국 같은 날 09:30)
export const kstDate = now => new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
