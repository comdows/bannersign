import { describe, expect, it } from "vitest";
import { adapterRegistry } from "./registry.js";

/**
 * 어댑터 계약 테스트 — 모든 등록 어댑터가 인터페이스 규약을 지키는지 공통 검증.
 * 새 어댑터를 registry에 추가하면 자동으로 이 테스트를 통과해야 한다.
 */
describe("adapter contract", () => {
  const entries = Object.entries(adapterRegistry);

  it("registry keys match adapter meta keys", () => {
    for (const [key, adapter] of entries) {
      expect(adapter.meta.key).toBe(key);
    }
  });

  it.each(entries)("%s implements all required methods", (_key, adapter) => {
    for (const method of [
      "fetchBoards",
      "fetchSchedule",
      "fetchSpec",
      "fetchResults",
      "login",
      "healthCheck",
      "submitApplication",
    ] as const) {
      expect(typeof adapter[method]).toBe("function");
    }
  });

  it.each(entries)("%s declares meta completely", (_key, adapter) => {
    expect(adapter.meta.nameKo.length).toBeGreaterThan(0);
    expect(adapter.meta.siteUrl).toMatch(/^https?:\/\//);
    expect(["none", "image", "unknown"]).toContain(adapter.meta.captchaType);
  });
});
