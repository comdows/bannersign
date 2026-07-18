import { createUriadAdapter } from "../uriad/factory.js";
import { HWASEONG } from "./config.js";

/**
 * 화성시(두리하나화성장애인자립센터) — uriad 템플릿, 2026-07-18 실측 완료.
 * 경로/필드 상세는 ./config.ts, 공통 플로우는 ../uriad/factory.ts 참고.
 */
export const hwaseongAdapter = createUriadAdapter({
  key: "hwaseong",
  nameKo: "화성시",
  baseUrl: HWASEONG.baseUrl,
  bizOfficeCode: HWASEONG.bizOfficeCode,
  autoSubmit: true,
  captchaType: "none",
  paths: {
    home: HWASEONG.paths.home,
    login: HWASEONG.paths.login,
    boards: HWASEONG.paths.boards,
    applyLottery: HWASEONG.paths.applyLottery,
    mypage: HWASEONG.paths.mypage,
    terms: HWASEONG.paths.terms,
  },
});
