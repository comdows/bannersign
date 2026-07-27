import type { ApplicationWindowInfo, BoardSiteInfo, CaptchaType } from "@youni/core";
import {
  AdapterError,
  type CrawlContext,
  type DecryptedCredential,
  type HealthReport,
  type MunicipalityAdapter,
  type ResultRowDraft,
  type SpecDraft,
  type SubmissionInput,
  type SubmissionReceipt,
  type SubmitContext,
  type WindowRef,
} from "../types.js";
import {
  parseBoardList,
  parseLotteryWindowFields,
  parseMypageResults,
  windowFromLotteryFields,
} from "./parsers.js";

/**
 * uriad.com 계열 현수막 게시대 접수 솔루션 공통 어댑터 팩토리.
 *
 * 2026-07-18 조사 기준 이 템플릿을 쓰는 접수처(약 20곳):
 * 화성(hsdr.or.kr, 실측 완료), 시흥(siheung.uriad.com, sub03 확인), 강서·구로·동작·
 * 금천(*.uriad.com), 안산, 군포, 오산(osankoaa), 안양(aykoaa), 용인(yikoaa),
 * 평택(ptkoaa), 남양주(nyjkoaa/nyjkappd/hid01) 등 — docs/site-research.md 참고.
 *
 * 공통 마커: directory1/map_view.jsp, fnBorder()/fnMapSmallShow() 게시대 목록,
 * sub03.jsp 추첨신청의 r_STARTDAY/r_ENDDAY hidden 필드, top_login.jsp(#id/#pw).
 * 사이트별로 경로가 조금씩 달라(예: ansan은 /public 하위) paths 오버라이드로 흡수한다.
 */
export interface UriadSiteConfig {
  key: string;
  nameKo: string;
  baseUrl: string;
  /** 사이트 내부 사업소 코드 (sub03.jsp hidden sBizoffcd, 예: 화성 B40, 오산 B30) */
  bizOfficeCode?: string;
  /** 실측/검증 전이면 false — worker가 자동 제출 대신 수동 안내 폴백 */
  autoSubmit: boolean;
  captchaType?: CaptchaType;
  paths?: Partial<UriadPaths>;
}

export interface UriadPaths {
  home: string;
  login: string;
  boards: string;
  applyLottery: string;
  /** 추첨신청 게시대선택 페이지 (sub03 규약동의 → goreserve()가 이동) */
  reservedList: string;
  /** 최종 제출 대상 (reservedList 폼 action) — 어댑터는 여기로 직접 이동하지 않음 */
  reservedSave: string;
  mypage: string;
  terms: string;
}

const DEFAULT_PATHS: UriadPaths = {
  home: "/",
  login: "/top_login.jsp",
  boards: "/sub02.jsp",
  applyLottery: "/sub03.jsp",
  reservedList: "/reserved_list.jsp",
  reservedSave: "/reserved_save.jsp",
  mypage: "/top_mypage.jsp",
  terms: "/reserved.jsp",
};

const SELECTORS = {
  login: {
    form: "form[name=form1]",
    username: "#id",
    password: "#pw",
    loggedIn: "a[href*='logout']",
  },
  boards: { rowAnchor: "a[onclick*='fnBorder']" },
  applyLottery: {
    agreeCheckbox: "#check",
    submitButton: "input[name=resrved_ok]",
    startDayHidden: "input[name=r_STARTDAY]",
  },
  reservedList: {
    row: "tr",
    boardCheckbox: "input[type=checkbox][name^=chkval]",
    adkindSelect: "select[name=adkind]",
    fileInput: "input[name=filename01]",
    saveForm: "form[action*='reserved_save']",
  },
} as const;

/** 광고 종류(select adkind): 규제 업종. 기본은 '해당사항없음'(0). */
const ADKIND_DEFAULT = "0";

export function createUriadAdapter(cfg: UriadSiteConfig): MunicipalityAdapter {
  const paths: UriadPaths = { ...DEFAULT_PATHS, ...cfg.paths };
  const url = (p: string) => `${cfg.baseUrl}${p}`;

  return {
    meta: {
      key: cfg.key,
      nameKo: cfg.nameKo,
      siteUrl: cfg.baseUrl,
      captchaType: cfg.captchaType ?? "none",
      autoSubmit: cfg.autoSubmit,
      onlinePayment: false,
      resultsRequireLogin: true, // 결과는 로그인 후 top_mypage.jsp에만 노출
    },

    async fetchBoards(ctx: CrawlContext): Promise<BoardSiteInfo[]> {
      await ctx.page.goto(url(paths.boards), { waitUntil: "domcontentloaded" });
      await ctx.audit.step("게시대 현황 페이지");
      const boards = parseBoardList(await ctx.page.content());
      if (boards.length === 0) {
        throw new AdapterError("selector_missing", `${cfg.key}: 게시대 목록 파싱 0건 — 구조 변경/경로 확인 필요`, false);
      }
      ctx.log(`${cfg.nameKo} 게시대 ${boards.length}건 수집`);
      return boards;
    },

    async fetchSchedule(ctx: CrawlContext): Promise<ApplicationWindowInfo[]> {
      await ctx.page.goto(url(paths.applyLottery), { waitUntil: "domcontentloaded" });
      await ctx.audit.step("추첨신청 페이지 (기간 필드)");
      const fields = parseLotteryWindowFields(await ctx.page.content());
      if (!fields) return [];
      const w = windowFromLotteryFields(fields);
      return w ? [w] : [];
    },

    async fetchSpec(ctx: CrawlContext): Promise<SpecDraft> {
      await ctx.page.goto(url(paths.terms), { waitUntil: "domcontentloaded" });
      await ctx.audit.step("규약사항");
      return { spec: {}, sourceUrl: ctx.page.url(), rawText: await ctx.page.innerText("body") };
    },

    async fetchResults(ctx: CrawlContext, _window: WindowRef): Promise<ResultRowDraft[]> {
      // uriad 결과는 공개 페이지가 아니라 로그인 후 개인 마이페이지(top_mypage.jsp)에 있다.
      // login()으로 인증된 SubmitContext에서 호출되면 마이페이지를 파싱한다.
      // (미인증 CrawlContext로 호출되면 로그인 페이지가 떠 결과 0건.)
      await ctx.page.goto(url(paths.mypage), { waitUntil: "domcontentloaded" });
      await ctx.audit.step("마이페이지(당첨현황)");
      const rows = parseMypageResults(await ctx.page.content());
      return rows.map((r) => ({
        applicantName: r.applicantName,
        boardExternalId: undefined,
        receiptNo: r.receiptNo,
        outcome: r.outcome,
        raw: { ...r.raw, boardName: r.boardName },
      }));
    },

    async login(ctx: SubmitContext, cred: DecryptedCredential): Promise<void> {
      const s = SELECTORS.login;
      await ctx.page.goto(url(paths.login), { waitUntil: "domcontentloaded" });
      await ctx.audit.step("로그인 페이지");
      await ctx.page.fill(s.username, cred.username);
      await ctx.page.fill(s.password, cred.password);
      await Promise.all([
        ctx.page.waitForLoadState("domcontentloaded"),
        ctx.page.locator(`${s.form} input[type=password]`).press("Enter"),
      ]);
      if ((await ctx.page.locator(s.loggedIn).count()) === 0) {
        await ctx.audit.step("로그인 실패");
        throw new AdapterError("login_failed", "로그인 실패 — 아이디/비밀번호 확인 필요", false);
      }
      await ctx.audit.step("로그인 완료");
    },

    async healthCheck(ctx: CrawlContext): Promise<HealthReport> {
      const failures: HealthReport["failures"] = [];
      const checks = [
        { name: "login_form", path: paths.login, selector: SELECTORS.login.username },
        { name: "board_list", path: paths.boards, selector: SELECTORS.boards.rowAnchor },
        { name: "lottery_window_fields", path: paths.applyLottery, selector: SELECTORS.applyLottery.startDayHidden },
      ];
      for (const c of checks) {
        try {
          await ctx.page.goto(url(c.path), { waitUntil: "domcontentloaded", timeout: 20_000 });
          if ((await ctx.page.locator(c.selector).count()) === 0) {
            failures.push({ check: c.name, detail: `selector not found: ${c.selector}` });
          }
        } catch (err) {
          failures.push({ check: c.name, detail: String(err) });
        }
      }
      await ctx.audit.step("healthCheck 완료");
      return { ok: failures.length === 0, checkedAt: new Date().toISOString(), failures };
    },

    async submitApplication(ctx: SubmitContext, input: SubmissionInput): Promise<SubmissionReceipt> {
      const s = SELECTORS.applyLottery;
      const r = SELECTORS.reservedList;
      // 로그인은 worker가 login()으로 선행. 여기서는 추첨신청 시작.
      await ctx.page.goto(url(paths.applyLottery), { waitUntil: "domcontentloaded" });
      await ctx.audit.step("추첨신청 페이지 진입");

      const fields = parseLotteryWindowFields(await ctx.page.content());
      if (fields) {
        const today = new Date(Date.now() + 9 * 3600_000).getUTCDate();
        if (today < fields.startDay || today > fields.endDay) {
          throw new AdapterError(
            "not_open_yet",
            `접수 기간(매월 ${fields.startDay}~${fields.endDay}일) 아님 — 창구 대기`,
            true,
          );
        }
      }

      // 규약 동의 → goreserve() → reserved_list.jsp(게시대선택+시안첨부)로 이동
      await ctx.page.locator(s.agreeCheckbox).check();
      await ctx.audit.step("규약 동의 체크");
      await Promise.all([
        ctx.page.waitForLoadState("domcontentloaded"),
        ctx.page.locator(s.submitButton).click(),
      ]);
      if (!ctx.page.url().includes(paths.reservedList.replace(/^\//, ""))) {
        // 기간 외이면 goreserve()가 alert로 막고 페이지 이동이 없다
        throw new AdapterError("not_open_yet", "게시대 선택 화면 진입 실패 (접수 기간/자격 확인)", true);
      }
      await ctx.audit.step("게시대 선택 화면");

      // 희망 게시대를 우선순위 순으로 선택 (행에 게시대명이 있는 체크박스)
      let selectedBoard: string | undefined;
      for (const pref of [...input.boardPreferences].sort((a, b) => a.priority - b.priority)) {
        const row = ctx.page.locator(r.row).filter({ hasText: pref.boardName }).first();
        const box = row.locator(r.boardCheckbox).first();
        if ((await box.count()) > 0 && (await box.isEnabled())) {
          await box.check();
          selectedBoard = pref.externalId;
          break; // 추첨은 1게시대 신청 (max_entries=1 정책)
        }
      }
      if (!selectedBoard) {
        await ctx.audit.step("희망 게시대 선택 불가");
        throw new AdapterError("boards_full", "우선순위 게시대가 모두 선택 불가(마감/미노출)", false);
      }
      await ctx.audit.step(`게시대 선택: ${selectedBoard}`);

      // 광고 종류 (규제 업종 분류) — 기본 '해당사항없음'
      const adkind = ctx.page.locator(r.adkindSelect);
      if ((await adkind.count()) > 0) await adkind.selectOption(ADKIND_DEFAULT).catch(() => {});

      // 시안 첨부 (jpg/gif)
      await ctx.page.locator(r.fileInput).setInputFiles(input.designFilePath);
      await ctx.audit.step("시안 첨부 완료");

      if (ctx.dryRun) {
        await ctx.audit.step("dry-run 종료 (최종 제출 직전)");
        ctx.log(`dry-run 완료 — 게시대 ${selectedBoard} 선택 + 시안 첨부까지 검증`);
        return { submittedAt: new Date().toISOString(), dryRun: true, selectedBoardExternalId: selectedBoard };
      }

      // 최종 제출: reserved_list 폼 submit → reserved_save.jsp
      await Promise.all([
        ctx.page.waitForLoadState("domcontentloaded"),
        ctx.page.locator(`${r.saveForm} input[type=image], ${r.saveForm} input[type=submit], ${r.saveForm} button[type=submit]`).first().click(),
      ]);
      await ctx.audit.step("제출 완료 화면");

      const bodyText = await ctx.page.innerText("body").catch(() => "");
      const receiptNo = /접수번호[^0-9]*([0-9-]{6,})/.exec(bodyText)?.[1];
      return {
        receiptNo,
        selectedBoardExternalId: selectedBoard,
        submittedAt: new Date().toISOString(),
        dryRun: false,
      };
    },
  };
}
