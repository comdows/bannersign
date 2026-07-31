import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../types.js";
import {
  parseBoardList,
  parseLotteryWindowFields,
  parseUriadSchedule,
  windowFromLotteryFields,
} from "../uriad/parsers.js";

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("hwaseong parsers (실HTML 픽스처 회귀, 2026-07-18 수집)", () => {
  it("parses board rows from sub02.jsp", () => {
    const boards = parseBoardList(fixture("boards.html"));
    expect(boards).toHaveLength(3);
    expect(boards[0]).toMatchObject({
      externalId: "97",
      name: "배양리입구",
      address: "기안동 460-117",
      fee: 13000,
      slotCount: 6,
      dimensionsCm: { width: 600, height: 70 },
    });
    expect(boards[0]!.lat).toBeCloseTo(37.2136, 3);
    expect(boards[0]!.lng).toBeCloseTo(126.9817, 3);
    expect(boards[0]!.raw).toMatchObject({ district: "기배동", periodDays: "7일", bizOfficeCode: "B40" });
  });

  it("extracts lottery window fields from sub03.jsp", () => {
    const fields = parseLotteryWindowFields(fixture("apply.html"));
    expect(fields).toMatchObject({
      startDay: 1,
      endDay: 5,
      startTime: "0000",
      endTime: "2400",
      targetMonth: "202608",
    });
  });

  it("builds a KST window instance (접수월 = 게시월 - 1)", () => {
    const fields = parseLotteryWindowFields(fixture("apply.html"))!;
    const w = windowFromLotteryFields(fields)!;
    expect(w.opensAt).toBe("2026-07-01T00:00:00+09:00");
    expect(w.closesAt).toBe("2026-07-05T23:59:00+09:00");
    expect(w.targetPeriodStart).toBe("2026-08-01T00:00:00+09:00");
    expect(w.targetPeriodEnd).toBe("2026-08-31T23:59:00+09:00");
    expect(w.selectionMethod).toBe("lottery");
  });

  it("maps board name to chkval checkbox row (reserved_list.jsp)", () => {
    const root = parse(fixture("reserved_list.html"));
    const rows = root
      .querySelectorAll("tr")
      .filter((tr) => tr.querySelector("input[name^=chkval]"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const first = rows[0]!;
    expect(first.text).toContain("배양리입구");
    expect(first.querySelector("input[name^=chkval]")).toBeTruthy();
  });
});

describe("parseUriadSchedule — 0건과 파서 실패 구분 (S03)", () => {
  it("apply.html 픽스처 → 창구 1건(일정 파싱 유지)", () => {
    const wins = parseUriadSchedule(fixture("apply.html"));
    expect(wins).toHaveLength(1);
    expect(wins[0]!.opensAt).toBe("2026-07-01T00:00:00+09:00");
    expect(wins[0]!.closesAt).toBe("2026-07-05T23:59:00+09:00");
    expect(wins[0]!.targetPeriodStart).toBe("2026-08-01T00:00:00+09:00");
  });

  it("기간 필드 부재 → selector_missing throw (조용한 [] 아님)", () => {
    let err: unknown;
    try {
      parseUriadSchedule("<html><body>현재 공지 없음</body></html>");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe("selector_missing");
  });

  it("잘못된 src_month(창구 생성 불가) → selector_missing throw", () => {
    const html =
      '<input name="r_STARTDAY" value="1"><input name="r_ENDDAY" value="5"><input name="src_month" value="bad">';
    expect(() => parseUriadSchedule(html)).toThrowError(AdapterError);
    expect(() => parseUriadSchedule(html)).toThrow(/src_month/);
  });
});
