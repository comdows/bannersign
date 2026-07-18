import type { BoardSiteInfo } from "@youni/core";
import { parse } from "node-html-parser";
import { HWASEONG } from "./config.js";
import type { ResultRowDraft } from "../types.js";

/**
 * 순수 HTML 파서 — Playwright 없이 픽스처로 CI에서 회귀 테스트한다.
 * 사이트 변경 시 fixtures/*.html을 새 스냅샷으로 교체하면 테스트가 깨져 즉시 감지된다.
 */

function cellText(cells: ReturnType<typeof parse>[], idx: number): string {
  return cells[idx]?.text.trim() ?? "";
}

export function parseBoardList(html: string): BoardSiteInfo[] {
  const root = parse(html);
  const cfg = HWASEONG.selectors.boards;
  return root.querySelectorAll(cfg.row).map((tr) => {
    const cells = tr.querySelectorAll("td");
    const feeText = cellText(cells, cfg.cells.fee).replace(/[^\d]/g, "");
    const slotText = cellText(cells, cfg.cells.slots).replace(/[^\d]/g, "");
    return {
      externalId: cellText(cells, cfg.cells.externalId),
      name: cellText(cells, cfg.cells.name),
      address: cellText(cells, cfg.cells.address) || undefined,
      slotCount: slotText ? Number(slotText) : undefined,
      fee: feeText ? Number(feeText) : undefined,
      raw: { html: tr.text.trim() },
    };
  });
}

export function parseResults(html: string): ResultRowDraft[] {
  const root = parse(html);
  const cfg = HWASEONG.selectors.results;
  return root.querySelectorAll(cfg.row).map((tr) => {
    const cells = tr.querySelectorAll("td");
    const outcomeText = cellText(cells, cfg.cells.outcome);
    const outcome = /선정|당첨/.test(outcomeText)
      ? "selected"
      : /탈락|미선정/.test(outcomeText)
        ? "rejected"
        : "unknown";
    return {
      boardExternalId: undefined,
      applicantName: cellText(cells, cfg.cells.applicantName) || undefined,
      receiptNo: cellText(cells, cfg.cells.receiptNo) || undefined,
      outcome,
      raw: {
        boardName: cellText(cells, cfg.cells.boardName),
        outcomeText,
      },
    };
  });
}
