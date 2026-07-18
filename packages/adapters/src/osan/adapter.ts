import type { MunicipalityAdapter } from "../types.js";
import { AdapterError } from "../types.js";

/**
 * 오산시 어댑터 스텁 — 사이트 조사 후 hwaseong 어댑터를 본보기로 구현한다.
 * 구현 전까지 autoSubmit=false: worker는 이 지자체 잡을 needs_manual로 돌려
 * 사용자에게 수동 신청 안내(assisted manual)를 보낸다.
 */
export const osanAdapter: MunicipalityAdapter = {
  meta: {
    key: "osan",
    nameKo: "오산시",
    siteUrl: "https://example-osan-banner.kr", // TODO: 실제 사이트 URL
    captchaType: "unknown",
    autoSubmit: false,
    onlinePayment: false,
  },

  async fetchBoards() {
    throw new AdapterError("unknown", "osan adapter not implemented", false);
  },
  async fetchSchedule() {
    return []; // window_rule 기반 생성 사용
  },
  async fetchSpec() {
    throw new AdapterError("unknown", "osan adapter not implemented", false);
  },
  async fetchResults() {
    throw new AdapterError("unknown", "osan adapter not implemented", false);
  },
  async login() {
    throw new AdapterError("unknown", "osan adapter not implemented", false);
  },
  async healthCheck() {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      failures: [{ check: "implemented", detail: "osan adapter not implemented" }],
    };
  },
  async submitApplication() {
    throw new AdapterError("unknown", "osan adapter not implemented", false);
  },
};
