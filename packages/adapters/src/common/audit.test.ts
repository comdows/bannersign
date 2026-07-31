import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { createAuditTrail, memorySink, stepNameOnlyAuditTrail } from "./audit.js";

/** 캡처 호출 횟수를 세는 최소 Page 대역 */
function countingPage() {
  const calls = { screenshot: 0, content: 0 };
  const page = {
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
});
