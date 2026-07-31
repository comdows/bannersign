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

/**
 * 단계 이름만 남기는 감사 증적 (S04 사전 점검용).
 *
 * 로그인 사전 점검은 스크린샷·HTML 을 남기지 않는다: 로그인 페이지/직후 화면에는
 * 입력된 아이디, 세션 쿠키가 반영된 마크업, 개인정보가 그대로 담기기 때문이다.
 * page 를 아예 만지지 않으므로 캡처 자체가 일어나지 않는다(증적 sink 로 흘러갈
 * 여지도 없다). 어댑터 계약(audit.step 호출)은 그대로 만족한다.
 */
export function stepNameOnlyAuditTrail(): AuditTrail {
  const steps: string[] = [];
  return {
    steps,
    async step(name: string) {
      steps.push(name);
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
