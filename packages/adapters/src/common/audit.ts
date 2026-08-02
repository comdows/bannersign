import type { Page } from "playwright";
import type { AuditEvidence, AuditTrail } from "../types.js";

export const DRY_RUN_AUDIT_STEP = {
  loginComplete: "login_complete",
  termsAgreed: "terms_agreed",
  boardSelected: "board_selected",
  designAttached: "design_attached",
  finalBeforeSubmit: "final_before_submit",
} as const;

export const REQUIRED_DRY_RUN_AUDIT_STEPS = [
  DRY_RUN_AUDIT_STEP.loginComplete,
  DRY_RUN_AUDIT_STEP.termsAgreed,
  DRY_RUN_AUDIT_STEP.boardSelected,
  DRY_RUN_AUDIT_STEP.designAttached,
  DRY_RUN_AUDIT_STEP.finalBeforeSubmit,
] as const;

export type RequiredDryRunAuditStep = (typeof REQUIRED_DRY_RUN_AUDIT_STEPS)[number];

export interface DryRunAuditValidation {
  valid: boolean;
  missingSteps: RequiredDryRunAuditStep[];
}

export interface AuditSink {
  /** 스크린샷/HTML을 저장하고 storage 경로를 반환 */
  saveScreenshot(stepName: string, png: Buffer): Promise<string>;
  saveHtml(stepName: string, html: string): Promise<string>;
}

/** 증적에 비밀값이 섞이기 쉬운 query/fragment를 남기지 않는다. */
export function sanitizeAuditUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.split(/[?#]/, 1)[0] ?? "";
  }
}

function hasValidTimestamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function hasValidUrl(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** dry-run 완료 판정에 필요한 다섯 증적의 필수 필드를 검증한다. HTML은 선택 사항이다. */
export function validateDryRunAuditEvidence(
  evidence: readonly AuditEvidence[],
): DryRunAuditValidation {
  const missingSteps = REQUIRED_DRY_RUN_AUDIT_STEPS.filter(
    (requiredStep) =>
      !evidence.some(
        (entry) =>
          entry.step === requiredStep &&
          Boolean(entry.screenshotPath?.trim()) &&
          hasValidUrl(entry.url) &&
          hasValidTimestamp(entry.capturedAt),
      ),
  );
  return { valid: missingSteps.length === 0, missingSteps };
}

/**
 * Playwright Page 기반 감사 증적 구현.
 * audit.step("로그인 완료") 호출마다 스크린샷 + HTML 스냅샷을 sink에 저장한다.
 */
export function createAuditTrail(page: Page, sink: AuditSink): AuditTrail {
  const steps: string[] = [];
  const evidence: AuditEvidence[] = [];
  return {
    steps,
    evidence,
    async step(name: string, evidenceStep = name) {
      steps.push(name);

      const capturedAt = new Date().toISOString();
      let currentUrl = "";
      try {
        currentUrl = sanitizeAuditUrl(page.url());
      } catch {
        // URL을 읽지 못한 사실도 빈 URL 증적으로 남겨 validator가 거부하게 한다.
      }

      let screenshotPath: string | null = null;
      try {
        const png = await page.screenshot({ fullPage: false });
        screenshotPath = await sink.saveScreenshot(evidenceStep, png);
      } catch {
        // 저장 실패는 null path로 남기고 HTML 캡처는 계속 시도한다.
      }

      let htmlPath: string | null = null;
      try {
        const html = await page.content();
        htmlPath = await sink.saveHtml(evidenceStep, html);
      } catch {
        // HTML은 선택 증적이다. 실패하더라도 스크린샷 결과를 보존한다.
      }

      evidence.push({
        step: evidenceStep,
        url: currentUrl,
        capturedAt,
        screenshotPath,
        htmlPath,
      });
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
  const evidence: AuditEvidence[] = [];
  return {
    steps,
    evidence,
    async step(name: string, evidenceStep = name) {
      steps.push(name);
      evidence.push({
        step: evidenceStep,
        url: "",
        capturedAt: new Date().toISOString(),
        screenshotPath: null,
        htmlPath: null,
      });
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
