import type { Page } from "playwright";
import type { AuditTrail } from "../types.js";

export interface AuditSink {
  /** 스크린샷/HTML을 저장하고 storage 경로를 반환 */
  saveScreenshot(stepName: string, png: Buffer): Promise<string>;
  saveHtml(stepName: string, html: string): Promise<string>;
}

/**
 * Playwright Page 기반 감사 증적 구현.
 * audit.step("로그인 완료") 호출마다 스크린샷 + HTML 스냅샷을 sink에 저장한다.
 */
export function createAuditTrail(page: Page, sink: AuditSink): AuditTrail {
  const steps: string[] = [];
  return {
    steps,
    async step(name: string) {
      steps.push(name);
      try {
        const png = await page.screenshot({ fullPage: false });
        await sink.saveScreenshot(name, png);
        const html = await page.content();
        await sink.saveHtml(name, html);
      } catch {
        // 증적 저장 실패가 제출 자체를 막으면 안 됨 — 단계 이름만 남긴다
      }
    },
  };
}

/** 테스트/dry-run용 no-op sink */
export function memorySink(): AuditSink & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    async saveScreenshot(step) {
      saved.push(`screenshot:${step}`);
      return `memory://screenshot/${step}`;
    },
    async saveHtml(step) {
      saved.push(`html:${step}`);
      return `memory://html/${step}`;
    },
  };
}
