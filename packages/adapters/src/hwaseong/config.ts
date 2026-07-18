/**
 * 화성시 어댑터 설정 — 2026-07-18 실측 (https://www.hsdr.or.kr).
 * 운영: 두리하나화성장애인자립센터 (화성시 현수막 지정게시대 수탁, TEL 031-366-7922)
 *
 * 실측 확인 사항:
 * - 인코딩 EUC-KR, uriad.com 솔루션 기반 (구로 guro.uriad.com 등과 동일 벤더)
 * - 접수 기간: 매월 1일 00:00 ~ 5일 24:00 (sub03.jsp hidden 필드 r_STARTDAY/r_ENDDAY)
 * - 추첨신청(sub03.jsp): 로그인 필수, 규약 동의 체크(#check) 후 goreserve() 제출.
 *   ※ 동의 이후 게시대 선택 단계는 로그인 세션 필요 — 실계정 dry-run으로 후속 실측 (TODO)
 * - 게시대 목록(sub02.jsp): 198개, fnBorder('B40','<id>') / fnMapSmallShow(lng,lat,name,addr)
 * - 시안 등록: sub09-04.jsp 대화방(시안등록) — 추첨 접수 시 최종 시안 첨부 필수
 * - 결과 확인: top_mypage.jsp 나의신청현황 (로그인 필요, TODO 실측)
 * - 로그인 폼에 캡차 없음 (form1, #id, #pw, goLogin())
 */
export const HWASEONG = {
  baseUrl: "https://www.hsdr.or.kr",
  /** 사이트 내부 사업소 코드 (sub03.jsp hidden sBizoffcd) */
  bizOfficeCode: "B40",
  paths: {
    home: "/index_hsdr.jsp",
    login: "/top_login.jsp",
    join: "/top_join.jsp",
    boards: "/sub02.jsp",          // 게시대현황및위치안내
    dailyStatus: "/sub02-02.jsp",  // 일일신청현황
    applyLottery: "/sub03.jsp",    // 추첨신청하기 (매월 1~5일)
    applyRealtime: "/sub04_all.jsp", // 미배정게시대신청하기 (실시간)
    mypage: "/top_mypage.jsp",     // 나의신청현황 (결과 확인)
    notice: "/sub09.jsp",
    designRoom: "/sub09-04.jsp",   // 대화방(시안등록)
    terms: "/reserved.jsp",        // 규약사항 팝업
    designGuidePdf: "/files/guide_20250602.pdf",
    manualPdf: "/files/manual_2026.pdf",
  },
  selectors: {
    login: {
      form: "form[name=form1]",
      username: "#id",
      password: "#pw",
      // goLogin() onsubmit — 폼 submit으로 트리거
      loggedIn: "a[href*='logout']",
    },
    boards: {
      // 게시대 행: fnBorder('B40','<externalId>') 앵커가 있는 tr
      rowAnchor: "a[onclick*='fnBorder']",
    },
    applyLottery: {
      form: "form[name=form1]",
      agreeCheckbox: "#check",
      submitButton: "input[name=resrved_ok]", // goreserve() 이미지 버튼
      // 접수 기간 hidden 필드 (관리자 설정값)
      hidden: {
        startDay: "input[name=r_STARTDAY]",
        endDay: "input[name=r_ENDDAY]",
        startTime: "input[name=r_STARTTIME]",
        endTime: "input[name=r_ENDTIME]",
        targetMonth: "input[name=src_month]", // 예: 202608 (게시 대상월)
      },
    },
  },
} as const;
