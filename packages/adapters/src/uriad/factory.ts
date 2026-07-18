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
import { parseBoardList, parseLotteryWindowFields, windowFromLotteryFields } from "./parsers.js";

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
  mypage: string;
  terms: string;
}

const DEFAULT_PATHS: UriadPaths = {
  home: "/",
  login: "/top_login.jsp",
  boards: "/sub02.jsp",
  applyLottery: "/sub03.jsp",
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
} as const;

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
      // uriad 계열은 결과를 로그인 후 '나의신청현황'(top_mypage.jsp)에서 확인.
      // TODO(실계정 dry-run 후): 마이페이지 파싱 구현.
      ctx.log(`${cfg.key} fetchResults: 마이페이지 실측 전 — 미구현`);
      return [];
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

      await ctx.page.locator(s.agreeCheckbox).check();
      await ctx.audit.step("규약 동의 체크");
      await Promise.all([
        ctx.page.waitForLoadState("domcontentloaded"),
        ctx.page.locator(s.submitButton).click(),
      ]);
      await ctx.audit.step("추첨신청 다음 단계 화면"); // 후속 단계 실측용 증적

      // TODO(로그인 세션 실측): 게시대 선택 → 시안 첨부 → 최종 제출 단계.
      if (ctx.dryRun) {
        ctx.log(`dry-run 종료 — 다음 단계 증적 수집 (희망 게시대 ${input.boardPreferences.length}곳)`);
        return { submittedAt: new Date().toISOString(), dryRun: true };
      }
      throw new AdapterError(
        "selector_missing",
        `${cfg.key}: 추첨신청 후속 단계 미실측 — dry-run 증적 확인 후 어댑터 완성 필요`,
        false,
      );
    },
  };
}
