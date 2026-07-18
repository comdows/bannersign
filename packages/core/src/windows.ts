import type { ApplicationWindowInfo, WindowRule } from "./types.js";

/**
 * WindowRule("매월 1~5일 접수")로부터 특정 연·월의 창구 인스턴스를 생성.
 * 스케줄러가 매일 실행하며, 생성된 인스턴스는 application_windows에 upsert된다.
 * KST 고정(지자체는 모두 Asia/Seoul).
 */
const KST_OFFSET = "+09:00";

function kstIso(year: number, month: number, day: number, time: string): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}T${time}:00${KST_OFFSET}`;
}

function addMonths(year: number, month: number, offset: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + offset;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function windowForMonth(rule: WindowRule, year: number, month: number): ApplicationWindowInfo {
  const closeDay = Math.min(rule.closeDayOfMonth, lastDayOfMonth(year, month));
  const target = addMonths(year, month, rule.targetMonthOffset);
  const targetLast = lastDayOfMonth(target.year, target.month);

  const closesAt = kstIso(year, month, closeDay, rule.closeTime);
  let resultExpectedAt: string | undefined;
  if (rule.resultAfterCloseDays != null) {
    const close = new Date(closesAt);
    close.setUTCDate(close.getUTCDate() + rule.resultAfterCloseDays);
    resultExpectedAt = close.toISOString();
  }

  return {
    opensAt: kstIso(year, month, rule.openDayOfMonth, rule.openTime),
    closesAt,
    targetPeriodStart: kstIso(target.year, target.month, 1, "00:00"),
    targetPeriodEnd: kstIso(target.year, target.month, targetLast, "23:59"),
    selectionMethod: rule.selectionMethod,
    resultExpectedAt,
  };
}

/** now 기준으로 이번 달/다음 달 창구 인스턴스 후보를 생성 (지난 창구는 제외) */
export function upcomingWindows(rule: WindowRule, now: Date): ApplicationWindowInfo[] {
  const kstNow = new Date(now.getTime() + 9 * 3600_000);
  const year = kstNow.getUTCFullYear();
  const month = kstNow.getUTCMonth() + 1;

  const candidates = [windowForMonth(rule, year, month)];
  const next = addMonths(year, month, 1);
  candidates.push(windowForMonth(rule, next.year, next.month));

  return candidates.filter((w) => new Date(w.closesAt).getTime() > now.getTime());
}
