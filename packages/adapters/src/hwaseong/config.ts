/**
 * 화성시 어댑터 설정 — URL/셀렉터를 한 곳에 모아 사이트 변경 시 이 파일만 수정.
 *
 * TODO(운영 반영 전): baseUrl은 검색 기반 후보(화성시지체장애인협회 홈페이지,
 * docs/site-research.md 참고) — 게시대 접수 메뉴 위치와 실제 접수 도메인을 방문
 * 확인 후 paths/셀렉터를 실측값으로 교체하고 fixtures를 실제 HTML 스냅샷으로 갱신할 것.
 * 셀렉터는 전형적인 게시판형 신청 사이트 구조를 가정한 플레이스홀더다.
 */
export const HWASEONG = {
  baseUrl: "http://www.kappdhs.or.kr",
  paths: {
    login: "/member/login",
    boards: "/banner/boards",
    schedule: "/banner/notice",
    apply: "/banner/apply",
    results: "/banner/results",
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
