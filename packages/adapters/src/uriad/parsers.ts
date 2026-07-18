import type { ApplicationWindowInfo, BoardSiteInfo } from "@youni/core";
import { parse } from "node-html-parser";

/**
 * 화성 hsdr.or.kr 순수 HTML 파서 — 실HTML 픽스처로 CI 회귀 테스트.
 * 사이트는 EUC-KR 응답이므로 호출 측(Playwright page.content())에서 이미
 * 유니코드로 디코딩된 HTML을 받는다.
 */

const FN_BORDER = /fnBorder\('([^']*)','([^']*)'\)/;
const FN_MAP = /fnMapSmallShow\('([^']*)','([^']*)','([^']*)','([^']*)'\)/;
const NAME_DIMS = /^(.*?)\((\d+)\*(\d+)\)/;

/** sub02.jsp 게시대현황: fnBorder 앵커가 있는 tr에서 게시대 정보 추출 */
export function parseBoardList(html: string): BoardSiteInfo[] {
  const root = parse(html);
  const boards: BoardSiteInfo[] = [];
  const seen = new Set<string>();

  for (const anchor of root.querySelectorAll("a")) {
    const onclick = anchor.getAttribute("onclick") ?? "";
    const borderMatch = FN_BORDER.exec(onclick);
    if (!borderMatch) continue;
    const externalId = borderMatch[2]!;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const rawName = anchor.text.trim();
    const nameMatch = NAME_DIMS.exec(rawName);
    const name = nameMatch?.[1]?.trim() || rawName;
    const dims = nameMatch
      ? { width: Number(nameMatch[2]), height: Number(nameMatch[3]) }
      : undefined;

    // 같은 tr 안의 좌표/주소(fnMapSmallShow)와 td 컬럼(행정동/게시기간/요금/규격/면수)
    let tr = anchor.parentNode;
    while (tr && tr.rawTagName?.toLowerCase() !== "tr") tr = tr.parentNode;

    let lat: number | undefined;
    let lng: number | undefined;
    let address: string | undefined;
    let fee: number | undefined;
    let slotCount: number | undefined;
    let district: string | undefined;
    let periodDays: string | undefined;

    if (tr) {
      const mapMatch = FN_MAP.exec(tr.innerHTML);
      if (mapMatch) {
        lng = Number(mapMatch[1]);
        lat = Number(mapMatch[2]);
        address = mapMatch[4] || undefined;
      }
      // 컬럼: [순번] [게시대명...] [행정동] [게시기간 7일] [요금 13,000] [규격 600x70] [면수 6]
      const cells = tr.querySelectorAll("td").map((td) => td.text.trim());
      const feeText = cells.find((c) => /^[\d,]{4,}$/.test(c));
      if (feeText) fee = Number(feeText.replace(/,/g, ""));
      periodDays = cells.find((c) => /^\d+일$/.test(c));
      district = cells.find((c) => /^[가-힣]+(동|읍|면)$/.test(c));
      const specIdx = cells.findIndex((c) => /^\d+x\d+$/i.test(c));
      if (specIdx >= 0 && specIdx + 1 < cells.length && /^\d+$/.test(cells[specIdx + 1]!)) {
        slotCount = Number(cells[specIdx + 1]);
      }
    }

    boards.push({
      externalId,
      name,
      address,
      lat,
      lng,
      slotCount,
      fee,
      dimensionsCm: dims,
      raw: { district, periodDays, bizOfficeCode: borderMatch[1] },
    });
  }
  return boards;
}

export interface LotteryWindowFields {
  startDay: number; // r_STARTDAY (예: 1)
  endDay: number; // r_ENDDAY (예: 5)
  startTime: string; // "HHMM" (예: "0000")
  endTime: string; // "HHMM" (예: "2400")
  targetMonth: string; // src_month "YYYYMM" (게시 대상월, 예: "202608")
}

/** sub03.jsp 추첨신청 페이지의 hidden 필드에서 접수 기간 규칙 추출 */
export function parseLotteryWindowFields(html: string): LotteryWindowFields | null {
  const root = parse(html);
  const val = (name: string) =>
    root.querySelector(`input[name=${name}]`)?.getAttribute("value")?.trim();

  const startDay = val("r_STARTDAY");
  const endDay = val("r_ENDDAY");
  if (!startDay || !endDay) return null;
  return {
    startDay: Number(startDay),
    endDay: Number(endDay),
    startTime: val("r_STARTTIME") ?? "0000",
    endTime: val("r_ENDTIME") ?? "2400",
    targetMonth: val("src_month") ?? "",
  };
}

const KST = "+09:00";

/** hidden 필드 → 창구 인스턴스. 접수월은 게시 대상월(src_month)의 전월. */
export function windowFromLotteryFields(f: LotteryWindowFields): ApplicationWindowInfo | null {
  if (!/^\d{6}$/.test(f.targetMonth)) return null;
  const targetYear = Number(f.targetMonth.slice(0, 4));
  const targetMonth = Number(f.targetMonth.slice(4, 6));
  // 접수월 = 게시월 - 1
  const applyIdx = targetYear * 12 + (targetMonth - 1) - 1;
  const applyYear = Math.floor(applyIdx / 12);
  const applyMonth = (applyIdx % 12) + 1;

  const pad = (n: number) => String(n).padStart(2, "0");
  const time = (hhmm: string) =>
    hhmm === "2400" ? "23:59" : `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
  const targetLastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();

  return {
    opensAt: `${applyYear}-${pad(applyMonth)}-${pad(f.startDay)}T${time(f.startTime)}:00${KST}`,
    closesAt: `${applyYear}-${pad(applyMonth)}-${pad(f.endDay)}T${time(f.endTime)}:00${KST}`,
    targetPeriodStart: `${targetYear}-${pad(targetMonth)}-01T00:00:00${KST}`,
    targetPeriodEnd: `${targetYear}-${pad(targetMonth)}-${pad(targetLastDay)}T23:59:00${KST}`,
    selectionMethod: "lottery",
  };
}
