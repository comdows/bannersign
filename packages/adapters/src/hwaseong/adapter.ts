import type { ApplicationWindowInfo, BoardSiteInfo } from "@youni/core";
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
import { HWASEONG } from "./config.js";
import { parseBoardList, parseLotteryWindowFields, windowFromLotteryFields } from "./parsers.js";

const url = (path: string) => `${HWASEONG.baseUrl}${path}`;

/**
 * 화성시(두리하나화성장애인자립센터) 어댑터 — 2026-07-18 실측 기반.
 *
 * 접수 플로우(실측): 로그인 → sub03.jsp(추첨신청) → 규약 동의 체크 → goreserve() 제출
 *   → [로그인 세션 필요 구간: 게시대 선택 + 시안 첨부 + 최종 제출] ← TODO(실계정 dry-run으로 실측)
 * 최종 제출 전까지는 audit 스크린샷으로 다음 단계 화면을 수집해 어댑터를 완성한다.
 */
export const hwaseongAdapter: MunicipalityAdapter = {
  meta: {
    key: "hwaseong",
    nameKo: "화성시",
    siteUrl: HWASEONG.baseUrl,
    captchaType: "none", // 로그인 폼 캡차 없음 (실측). 후속 단계에서 발견 시 갱신
    autoSubmit: true,
    onlinePayment: false,
  },

  async fetchBoards(ctx: CrawlContext): Promise<BoardSiteInfo[]> {
    await ctx.page.goto(url(HWASEONG.paths.boards), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("게시대현황및위치안내");
    const boards = parseBoardList(await ctx.page.content());
    if (boards.length === 0) {
      throw new AdapterError("selector_missing", "게시대 목록 파싱 0건 — 사이트 구조 변경 의심", false);
    }
    ctx.log(`게시대 ${boards.length}건 수집 (실측 기준 198건)`);
    return boards;
  },

  async fetchSchedule(ctx: CrawlContext): Promise<ApplicationWindowInfo[]> {
    // 추첨신청 페이지 hidden 필드(r_STARTDAY 등)가 접수 기간의 원천
    await ctx.page.goto(url(HWASEONG.paths.applyLottery), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("추첨신청 페이지 (기간 필드)");
    const fields = parseLotteryWindowFields(await ctx.page.content());
    if (!fields) return [];
    const window_ = windowFromLotteryFields(fields);
    return window_ ? [window_] : [];
  },

  async fetchSpec(ctx: CrawlContext): Promise<SpecDraft> {
    // 규격은 디자인 안내문 PDF(guide)가 원천 — 텍스트는 규약 팝업에서 수집
    await ctx.page.goto(url(HWASEONG.paths.terms), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("규약사항 팝업");
    const rawText = await ctx.page.innerText("body");
    return {
      spec: {
        sizeCm: { width: 600, height: 70 },
        ratioTolerance: 0.03,
        fileFormats: ["jpg", "jpeg", "png"],
      },
      sourceUrl: url(HWASEONG.paths.designGuidePdf),
      rawText,
    };
  },

  async fetchResults(ctx: CrawlContext, _window: WindowRef): Promise<ResultRowDraft[]> {
    // 결과는 로그인 후 '나의신청현황'(top_mypage.jsp)에서 확인하는 구조.
    // TODO(실계정 확보 후): 로그인 세션으로 마이페이지 파싱 구현. 현재는 빈 배열.
    ctx.log("hwaseong fetchResults: 마이페이지 실측 전 — 결과 수집 미구현");
    return [];
  },

  async login(ctx: SubmitContext, cred: DecryptedCredential): Promise<void> {
    const s = HWASEONG.selectors.login;
    await ctx.page.goto(url(HWASEONG.paths.login), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("로그인 페이지");
    await ctx.page.fill(s.username, cred.username);
    await ctx.page.fill(s.password, cred.password);
    // goLogin() onsubmit 트리거를 위해 폼 submit
    await Promise.all([
      ctx.page.waitForLoadState("domcontentloaded"),
      ctx.page.locator(`${s.form} input[type=password]`).press("Enter"),
    ]);

    const loggedIn = await ctx.page.locator(s.loggedIn).count();
    if (loggedIn === 0) {
      await ctx.audit.step("로그인 실패");
      throw new AdapterError("login_failed", "로그인 실패 — 아이디/비밀번호 확인 필요", false);
    }
    await ctx.audit.step("로그인 완료");
  },

  async healthCheck(ctx: CrawlContext): Promise<HealthReport> {
    const failures: HealthReport["failures"] = [];
    const checks = [
      { name: "login_form", path: HWASEONG.paths.login, selector: HWASEONG.selectors.login.username },
      { name: "board_list", path: HWASEONG.paths.boards, selector: HWASEONG.selectors.boards.rowAnchor },
      {
        name: "lottery_window_fields",
        path: HWASEONG.paths.applyLottery,
        selector: HWASEONG.selectors.applyLottery.hidden.startDay,
      },
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
    const s = HWASEONG.selectors.applyLottery;
    await ctx.page.goto(url(HWASEONG.paths.applyLottery), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("추첨신청 페이지 진입");

    // 접수 기간 확인 (hidden 필드 기준 — 기간 외에는 goreserve()가 alert로 차단)
    const fields = parseLotteryWindowFields(await ctx.page.content());
    if (fields) {
      const today = new Date(Date.now() + 9 * 3600_000).getUTCDate(); // KST 일자
      if (today < fields.startDay || today > fields.endDay) {
        throw new AdapterError(
          "not_open_yet",
          `접수 기간(매월 ${fields.startDay}~${fields.endDay}일) 아님 — 창구 대기`,
          true,
        );
      }
    }

    // 규약 동의 후 신청 시작
    await ctx.page.locator(s.agreeCheckbox).check();
    await ctx.audit.step("규약 동의 체크");
    await Promise.all([
      ctx.page.waitForLoadState("domcontentloaded"),
      ctx.page.locator(s.submitButton).click(),
    ]);
    await ctx.audit.step("추첨신청 다음 단계 화면"); // ← 이 스크린샷으로 후속 단계 실측

    // TODO(로그인 세션 실측 필요): 게시대 선택 → 시안 첨부 → 최종 제출.
    // 후속 단계 구조를 아직 모르므로, dry-run이 아니면 진행하지 않고 수동 폴백으로 넘긴다.
    if (ctx.dryRun) {
      ctx.log(`dry-run 종료 — 다음 단계 화면 증적 수집 완료 (희망 게시대 ${input.boardPreferences.length}곳)`);
      return { submittedAt: new Date().toISOString(), dryRun: true };
    }
    throw new AdapterError(
      "selector_missing",
      "추첨신청 후속 단계(게시대 선택/시안 첨부) 미실측 — dry-run 증적 확인 후 어댑터 완성 필요",
      false,
    );
  },
};
