import { createUriadAdapter } from "../uriad/factory.js";

/**
 * 시흥시(siheung.uriad.com) — uriad 템플릿, sub03.jsp의 r_STARTDAY 필드까지
 * 화성과 동일 구조 확인(2026-07-18). 실계정 dry-run 리허설 전까지 autoSubmit=false.
 */
export const siheungAdapter = createUriadAdapter({
  key: "siheung",
  nameKo: "시흥시",
  baseUrl: "https://siheung.uriad.com",
  autoSubmit: false,
  captchaType: "none",
  paths: { home: "/index_shcity.jsp" },
});
