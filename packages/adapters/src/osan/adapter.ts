import { createUriadAdapter } from "../uriad/factory.js";

/**
 * 오산시(오산시광고협회, osankoaa.or.kr) — uriad 템플릿 확인 (bizoff B30).
 * sub03.jsp가 존재하나 r_STARTDAY 필드가 확인되지 않아(추첨 경로가 다를 수 있음)
 * autoSubmit=false: healthCheck/dry-run으로 경로 확정 후 활성화한다.
 */
export const osanAdapter = createUriadAdapter({
  key: "osan",
  nameKo: "오산시",
  baseUrl: "https://www.osankoaa.or.kr",
  bizOfficeCode: "B30",
  autoSubmit: false,
  captchaType: "unknown",
  paths: { home: "/index_osan.jsp" },
});
