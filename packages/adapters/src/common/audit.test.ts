import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import type { AuditEvidence } from "../types.js";
import {
  DRY_RUN_AUDIT_STEP,
  REQUIRED_DRY_RUN_AUDIT_STEPS,
  createAuditTrail,
  memorySink,
  sanitizeAuditUrl,
  stepNameOnlyAuditTrail,
  validateDryRunAuditEvidence,
} from "./audit.js";

/** 캡처 호출 횟수를 세는 최소 Page 대역 */
function countingPage() {
  const calls = { screenshot: 0, content: 0 };
  const page = {
    url() {
      return "https://example.test/apply?token=secret#form";
    },
    async screenshot() {
      calls.screenshot += 1;
      return Buffer.alloc(1);
    },
    async content() {
      calls.content += 1;
      return "<html><input id='pw' value='s3cr3t'></html>";
    },
  } as unknown as Page;
  return { page, calls };
}

describe("stepNameOnlyAuditTrail (S04 사전 점검용)", () => {
  it("단계 이름만 순서대로 기록한다", async () => {
    const audit = stepNameOnlyAuditTrail();
    await audit.step("로그인 페이지");
    await audit.step("로그인 완료");
    expect(audit.steps).toEqual(["로그인 페이지", "로그인 완료"]);
  });

  it("page 를 만지지 않아 스크린샷/HTML 이 캡처되지 않는다", async () => {
    const { page, calls } = countingPage();

    // 대조군: 기본 감사 증적은 단계마다 화면과 HTML 을 캡처한다.
    await createAuditTrail(page, memorySink()).step("로그인 완료");
    expect(calls).toEqual({ screenshot: 1, content: 1 });

    // 사전 점검용: 같은 단계를 남겨도 캡처가 한 번도 일어나지 않는다.
    await stepNameOnlyAuditTrail().step("로그인 완료");
    expect(calls).toEqual({ screenshot: 1, content: 1 });
  });

  it("sink 를 요구하지 않는다 — 저장 경로 자체가 없다", () => {
    expect(stepNameOnlyAuditTrail.length).toBe(0);
    const sink = memorySink();
    expect(sink.saved).toEqual([]); // 사전 점검은 sink 를 만들지도 않는다
  });

  it("캡처 없는 단계는 nullable path 증적으로 남긴다", async () => {
    const audit = stepNameOnlyAuditTrail();
    await audit.step("로그인 완료", DRY_RUN_AUDIT_STEP.loginComplete);
    expect(audit.evidence).toEqual([
      expect.objectContaining({
        step: DRY_RUN_AUDIT_STEP.loginComplete,
        url: "",
        screenshotPath: null,
        htmlPath: null,
      }),
    ]);
  });
});

describe("structured audit evidence", () => {
  it("query와 fragment를 제거하고 저장 경로를 구조화한다", async () => {
    const { page } = countingPage();
    const audit = createAuditTrail(page, memorySink());
    await audit.step("로그인 완료", DRY_RUN_AUDIT_STEP.loginComplete);

    expect(audit.steps).toEqual(["로그인 완료"]);
    expect(audit.evidence).toEqual([
      expect.objectContaining({
        step: DRY_RUN_AUDIT_STEP.loginComplete,
        url: "https://example.test/apply",
        screenshotPath: "memory://screenshot/login_complete",
        htmlPath: "memory://html/login_complete",
      }),
    ]);
    expect(Date.parse(audit.evidence[0]!.capturedAt)).not.toBeNaN();
  });

  it("스크린샷 저장 실패와 HTML 성공을 서로 구분한다", async () => {
    const { page } = countingPage();
    const audit = createAuditTrail(page, {
      async saveScreenshot() {
        throw new Error("storage unavailable");
      },
      async saveHtml() {
        return "memory://html/login_complete";
      },
    });
    await audit.step("로그인 완료", DRY_RUN_AUDIT_STEP.loginComplete);

    expect(audit.evidence[0]).toMatchObject({
      screenshotPath: null,
      htmlPath: "memory://html/login_complete",
    });
  });

  it("필수 5단계의 screenshot, URL, timestamp를 검증하고 HTML은 선택으로 둔다", () => {
    const complete = REQUIRED_DRY_RUN_AUDIT_STEPS.map<AuditEvidence>((step) => ({
      step,
      url: "https://example.test/reserved_list.jsp",
      capturedAt: "2026-08-02T00:00:00.000Z",
      screenshotPath: `memory://screenshot/${step}`,
      htmlPath: null,
    }));
    expect(validateDryRunAuditEvidence(complete)).toEqual({ valid: true, missingSteps: [] });

    complete[2] = { ...complete[2]!, screenshotPath: null };
    complete[4] = { ...complete[4]!, capturedAt: "not-a-timestamp" };
    expect(validateDryRunAuditEvidence(complete)).toEqual({
      valid: false,
      missingSteps: [DRY_RUN_AUDIT_STEP.boardSelected, DRY_RUN_AUDIT_STEP.finalBeforeSubmit],
    });
  });

  it("상대 URL에서도 query와 fragment를 제거한다", () => {
    expect(sanitizeAuditUrl("/reserved_list.jsp?token=secret#submit")).toBe(
      "/reserved_list.jsp",
    );
  });
});
