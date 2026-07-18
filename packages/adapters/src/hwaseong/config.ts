/**
 * 화성시 어댑터 설정 — URL/셀렉터를 한 곳에 모아 사이트 변경 시 이 파일만 수정.
 *
 * baseUrl은 화성시 현수막 게시대 접수처 실주소 (사용자 확인, 진입점 /index_hsdr.jsp).
 * TODO(운영 반영 전): paths/셀렉터는 아직 플레이스홀더 — 사이트 실측 후
 * 실제 메뉴 경로·폼 셀렉터로 교체하고 fixtures를 실제 HTML 스냅샷으로 갱신할 것.
 */
export const HWASEONG = {
  baseUrl: "https://www.hsdr.or.kr",
  paths: {
    home: "/index_hsdr.jsp",
    login: "/member/login",       // TODO: 실측
    boards: "/banner/boards",     // TODO: 실측
    schedule: "/banner/notice",   // TODO: 실측
    apply: "/banner/apply",       // TODO: 실측
    results: "/banner/results",   // TODO: 실측
  },
  selectors: {
    login: {
      username: "#userId",
      password: "#userPw",
      submit: "button[type=submit]",
      // 로그인 성공 판정: 로그아웃 링크 존재
      loggedIn: "a[href*='logout']",
      failMessage: ".login-error",
    },
    boards: {
      row: "table.board-list tbody tr",
      cells: { externalId: 0, name: 1, address: 2, slots: 3, fee: 4 },
    },
    apply: {
      businessName: "#bizName",
      bizRegNo: "#bizRegNo",
      representative: "#repName",
      phone: "#phone",
      email: "#email",
      address: "#address",
      boardSelect: "#boardSelect",
      fileInput: "input[type=file]",
      captchaImage: "img.captcha",
      captchaInput: "#captchaAnswer",
      agree: "#agreeTerms",
      submit: "#btnSubmit",
      // 접수기간 아님 안내 텍스트 후보
      notOpenText: /접수\s*기간이?\s*아닙니다|신청\s*기간이?\s*아닙니다/,
      receiptNo: ".receipt-no",
      alreadySubmittedText: /이미\s*신청/,
    },
    results: {
      row: "table.result-list tbody tr",
      cells: { boardName: 0, applicantName: 1, receiptNo: 2, outcome: 3 },
    },
  },
} as const;
