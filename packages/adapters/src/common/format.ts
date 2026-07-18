/** 한국 사업자등록번호 000-00-00000 포맷 */
export function formatBizRegNo(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 10) return raw;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/** 휴대전화 010-0000-0000 포맷 */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return raw;
}

/** "2026.08.01 ~ 2026.08.05" / "8월 1일부터 5일까지" 등에서 날짜 추출 보조 */
export function parseKoreanDateRange(text: string): { start?: string; end?: string } {
  const iso = (y: string, m: string, d: string) =>
    `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const full = text.match(
    /(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})일?\s*[~∼-]\s*(?:(\d{4})[.\-/년\s]*)?(?:(\d{1,2})[.\-/월\s]*)?(\d{1,2})일?/,
  );
  if (!full) return {};
  const [, y1, m1, d1, y2, m2, d2] = full;
  return {
    start: iso(y1!, m1!, d1!),
    end: iso(y2 ?? y1!, m2 ?? m1!, d2!),
  };
}
