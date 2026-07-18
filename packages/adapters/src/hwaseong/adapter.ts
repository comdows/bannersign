import type { ApplicationWindowInfo, BoardSiteInfo } from "@youni/core";
import { parseKoreanDateRange } from "../common/format.js";
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
import { parseBoardList, parseResults } from "./parsers.js";

const url = (path: string) => `${HWASEONG.baseUrl}${path}`;

/**
 * 화성시 레퍼런스 어댑터 — 이후 모든 지자체 어댑터의 본보기.
 * 규약:
 *  - 의미 단계마다 ctx.audit.step() 호출 (스크린샷+HTML 증적)
 *  - 오류는 AdapterError(code, retryable)로 분류해 던짐 (worker 재시도 정책이 code로 분기)
 *  - dryRun이면 최종 제출 클릭 직전에 중단
 */
export const hwaseongAdapter: MunicipalityAdapter = {
  meta: {
    key: "hwaseong",
    nameKo: "화성시",
    siteUrl: HWASEONG.baseUrl,
    captchaType: "image",
    autoSubmit: true,
    onlinePayment: false,
  },

  async fetchBoards(ctx: CrawlContext): Promise<BoardSiteInfo[]> {
    await ctx.page.goto(url(HWASEONG.paths.boards), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("게시대 목록 페이지");
    const html = await ctx.page.content();
    const boards = parseBoardList(html);
    if (boards.length === 0) {
      throw new AdapterError("selector_missing", "게시대 목록 파싱 결과 0건 — 사이트 구조 변경 의심", false);
    }
    ctx.log(`게시대 ${boards.length}건 수집`);
    return boards;
  },

  async fetchSchedule(ctx: CrawlContext): Promise<ApplicationWindowInfo[]> {
    await ctx.page.goto(url(HWASEONG.paths.schedule), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("접수 일정 공지 페이지");
    const text = await ctx.page.innerText("body");
    const range = parseKoreanDateRange(text);
    if (!range.start || !range.end) return []; // 공지에서 못 찾으면 window_rule 기반 생성에 맡김
    return [
      {
        opensAt: `${range.start}T09:00:00+09:00`,
        closesAt: `${range.end}T18:00:00+09:00`,
        targetPeriodStart: "",
        targetPeriodEnd: "",
        selectionMethod: "lottery",
      },
    ];
  },

  async fetchSpec(ctx: CrawlContext): Promise<SpecDraft> {
    await ctx.page.goto(url(HWASEONG.paths.schedule), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("규격 공지 페이지");
    const rawText = await ctx.page.innerText("body");
    // 자유 텍스트 → 구조화는 packages/ai의 parseSpecFromText로 수행하고 관리자 검수를 거친다
    return { spec: {}, sourceUrl: ctx.page.url(), rawText };
  },

  async fetchResults(ctx: CrawlContext, _window: WindowRef): Promise<ResultRowDraft[]> {
    await ctx.page.goto(url(HWASEONG.paths.results), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("선정 결과 페이지");
    return parseResults(await ctx.page.content());
  },

  async login(ctx: SubmitContext, cred: DecryptedCredential): Promise<void> {
    const s = HWASEONG.selectors.login;
    await ctx.page.goto(url(HWASEONG.paths.login), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("로그인 페이지");
    await ctx.page.fill(s.username, cred.username);
    await ctx.page.fill(s.password, cred.password);
    await ctx.page.click(s.submit);
    await ctx.page.waitForLoadState("domcontentloaded");

    const loggedIn = await ctx.page.locator(s.loggedIn).count();
    if (loggedIn === 0) {
      const fail = await ctx.page.locator(s.failMessage).count();
      await ctx.audit.step("로그인 실패");
      throw new AdapterError(
        "login_failed",
        fail > 0 ? "아이디/비밀번호 불일치" : "로그인 후 상태 확인 실패",
        false,
      );
    }
    await ctx.audit.step("로그인 완료");
  },

  async healthCheck(ctx: CrawlContext): Promise<HealthReport> {
    const failures: HealthReport["failures"] = [];
    const checks: Array<{ name: string; path: string; selector: string }> = [
      { name: "login_form", path: HWASEONG.paths.login, selector: HWASEONG.selectors.login.username },
      { name: "board_list", path: HWASEONG.paths.boards, selector: HWASEONG.selectors.boards.row },
    ];
    for (const c of checks) {
      try {
        await ctx.page.goto(url(c.path), { waitUntil: "domcontentloaded", timeout: 15_000 });
        const count = await ctx.page.locator(c.selector).count();
        if (count === 0) failures.push({ check: c.name, detail: `selector not found: ${c.selector}` });
      } catch (err) {
        failures.push({ check: c.name, detail: String(err) });
      }
    }
    await ctx.audit.step("healthCheck 완료");
    return { ok: failures.length === 0, checkedAt: new Date().toISOString(), failures };
  },

  async submitApplication(ctx: SubmitContext, input: SubmissionInput): Promise<SubmissionReceipt> {
    const s = HWASEONG.selectors.apply;
    await ctx.page.goto(url(HWASEONG.paths.apply), { waitUntil: "domcontentloaded" });
    await ctx.audit.step("신청 페이지 진입");

    const bodyText = await ctx.page.innerText("body");
    if (s.notOpenText.test(bodyText)) {
      throw new AdapterError("not_open_yet", "접수 기간이 아님 — 창구 오픈 대기", true);
    }
    if (s.alreadySubmittedText.test(bodyText)) {
      throw new AdapterError("already_submitted", "이미 접수된 신청 존재", false);
    }

    // 신청자 정보
    await ctx.page.fill(s.businessName, input.profile.businessName);
    if (input.profile.bizRegNo) await ctx.page.fill(s.bizRegNo, input.profile.bizRegNo);
    if (input.profile.representative) await ctx.page.fill(s.representative, input.profile.representative);
    await ctx.page.fill(s.phone, input.profile.phone);
    if (input.profile.email) await ctx.page.fill(s.email, input.profile.email);
    if (input.profile.address) await ctx.page.fill(s.address, input.profile.address);
    await ctx.audit.step("신청자 정보 입력 완료");

    // 게시대 선택 — 우선순위 순으로 선택 가능한 첫 게시대
    let selected: string | undefined;
    for (const pref of [...input.boardPreferences].sort((a, b) => a.priority - b.priority)) {
      const option = ctx.page.locator(`${s.boardSelect} option[value="${pref.externalId}"]:not([disabled])`);
      if ((await option.count()) > 0) {
        await ctx.page.selectOption(s.boardSelect, pref.externalId);
        selected = pref.externalId;
        break;
      }
    }
    if (!selected) {
      await ctx.audit.step("게시대 전체 매진");
      throw new AdapterError("boards_full", "우선순위 게시대가 모두 선택 불가(매진)", false);
    }
    await ctx.audit.step(`게시대 선택: ${selected}`);

    // 시안 업로드
    await ctx.page.setInputFiles(s.fileInput, input.designFilePath);
    await ctx.audit.step("시안 업로드 완료");

    // 캡차 — 사용자 릴레이
    const captchaImg = ctx.page.locator(s.captchaImage);
    if ((await captchaImg.count()) > 0) {
      const buf = await captchaImg.screenshot();
      await ctx.audit.step("캡차 발견 — 릴레이 대기");
      const answer = await ctx.onCaptcha(buf);
      await ctx.page.fill(s.captchaInput, answer);
      await ctx.audit.step("캡차 입력 완료");
    }

    const agree = ctx.page.locator(s.agree);
    if ((await agree.count()) > 0) await agree.check();

    if (ctx.dryRun) {
      await ctx.audit.step("dry-run 종료 (제출 직전)");
      return { submittedAt: new Date().toISOString(), dryRun: true, selectedBoardExternalId: selected };
    }

    await ctx.page.click(s.submit);
    await ctx.page.waitForLoadState("domcontentloaded");
    await ctx.audit.step("제출 완료 화면");

    const receiptLocator = ctx.page.locator(s.receiptNo);
    const receiptNo = (await receiptLocator.count()) > 0 ? (await receiptLocator.innerText()).trim() : undefined;

    return {
      receiptNo,
      selectedBoardExternalId: selected,
      submittedAt: new Date().toISOString(),
      dryRun: false,
    };
  },
};
