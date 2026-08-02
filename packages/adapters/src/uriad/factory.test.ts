import { describe, expect, it, vi } from "vitest";
import type { Page, Route } from "playwright";
import { createAuditTrail, memorySink, validateDryRunAuditEvidence } from "../common/audit.js";
import { AdapterError, type SubmissionInput, type SubmitContext } from "../types.js";
import { createUriadAdapter } from "./factory.js";

const BASE_URL = "https://uriad.example.test";
const FINAL_SAVE_PATH = "/reserved_save.jsp";

type RouteHandler = (route: Route) => Promise<void> | void;

class FakeUriadPage {
  private currentUrl = `${BASE_URL}/`;
  private loggedIn = false;
  private routeHandler: RouteHandler | undefined;

  readonly requestAttempts: string[] = [];
  readonly completedRequests: string[] = [];
  finalSubmitClicks = 0;
  uploadedFile: string | undefined;

  constructor(private readonly submitOnFileAttach = false) {}

  asPage(): Page {
    return this as unknown as Page;
  }

  url(): string {
    return this.currentUrl;
  }

  async route(_pattern: string, handler: RouteHandler): Promise<void> {
    this.routeHandler = handler;
  }

  async unroute(_pattern: string, handler: RouteHandler): Promise<void> {
    if (this.routeHandler === handler) this.routeHandler = undefined;
  }

  async goto(target: string): Promise<null> {
    await this.navigate(target);
    return null;
  }

  async waitForLoadState(): Promise<void> {}

  async screenshot(): Promise<Buffer> {
    return Buffer.from("fake screenshot");
  }

  async content(): Promise<string> {
    return "<html><body>fake uriad page</body></html>";
  }

  async fill(): Promise<void> {}

  async innerText(): Promise<string> {
    return "접수번호 2026-08-0001";
  }

  locator(selector: string): unknown {
    if (selector === "a[href*='logout']") {
      return { count: async () => (this.loggedIn ? 1 : 0) };
    }

    if (selector === "form[name=form1] input[type=password]") {
      return {
        press: async () => {
          this.loggedIn = true;
          this.currentUrl = `${BASE_URL}/`;
        },
      };
    }

    if (selector === "#check") {
      return { check: async () => {} };
    }

    if (selector === "input[name=resrved_ok]") {
      return { click: async () => this.navigate(`${BASE_URL}/reserved_list.jsp`) };
    }

    if (selector === "tr") {
      return {
        filter: ({ hasText }: { hasText: string }) => ({
          first: () => ({
            locator: () => ({
              first: () => ({
                count: async () => (hasText === "중앙 게시대" ? 1 : 0),
                isEnabled: async () => true,
                check: async () => {},
              }),
            }),
          }),
        }),
      };
    }

    if (selector === "select[name=adkind]") {
      return {
        count: async () => 1,
        selectOption: async () => {},
      };
    }

    if (selector === "input[name=filename01]") {
      return {
        setInputFiles: async (path: string) => {
          this.uploadedFile = path;
          if (this.submitOnFileAttach) {
            await this.dispatchRequest(`${BASE_URL}${FINAL_SAVE_PATH}?unexpected=true`);
          }
        },
      };
    }

    if (selector.includes("form[action*='reserved_save']")) {
      return {
        first: () => ({
          click: async () => {
            this.finalSubmitClicks += 1;
            await this.navigate(`${BASE_URL}${FINAL_SAVE_PATH}`);
          },
        }),
      };
    }

    return { count: async () => 0 };
  }

  private async navigate(target: string): Promise<void> {
    if (await this.dispatchRequest(target)) this.currentUrl = target;
  }

  private async dispatchRequest(target: string): Promise<boolean> {
    this.requestAttempts.push(target);
    if (!this.routeHandler) {
      this.completedRequests.push(target);
      return true;
    }

    let aborted = false;
    const route = {
      request: () => ({ url: () => target }),
      abort: async () => {
        aborted = true;
      },
      continue: async () => {},
    } as unknown as Route;
    await this.routeHandler(route);
    if (!aborted) this.completedRequests.push(target);
    return !aborted;
  }
}

const adapter = createUriadAdapter({
  key: "fake-uriad",
  nameKo: "테스트 URIAD",
  baseUrl: BASE_URL,
  autoSubmit: true,
});

const submission: SubmissionInput = {
  profile: {
    businessName: "테스트 상사",
    phone: "010-0000-0000",
  },
  boardPreferences: [
    {
      boardSiteId: "board-site-1",
      externalId: "board-97",
      boardName: "중앙 게시대",
      priority: 1,
    },
  ],
  designFilePath: "C:/fixtures/design.jpg",
  targetPeriod: { start: "2026-09-01", end: "2026-09-07" },
};

function contextFor(fake: FakeUriadPage, dryRun: boolean): SubmitContext {
  const page = fake.asPage();
  return {
    page,
    audit: createAuditTrail(page, memorySink()),
    log: vi.fn(),
    dryRun,
    onCaptcha: async () => "",
  };
}

function finalSaveRequests(urls: readonly string[]): string[] {
  return urls.filter((candidate) => new URL(candidate).pathname === FINAL_SAVE_PATH);
}

describe("URIAD dry-run safety", () => {
  it("로그인부터 최종 제출 직전까지 5단계 증적을 남기고 final save를 요청하지 않는다", async () => {
    const fake = new FakeUriadPage();
    const ctx = contextFor(fake, true);

    await adapter.login(ctx, { username: "test-user", password: "test-password" });
    const receipt = await adapter.submitApplication(ctx, submission);

    expect(receipt).toMatchObject({
      dryRun: true,
      selectedBoardExternalId: "board-97",
    });
    expect(fake.uploadedFile).toBe(submission.designFilePath);
    expect(fake.finalSubmitClicks).toBe(0);
    expect(finalSaveRequests(fake.requestAttempts)).toEqual([]);
    expect(finalSaveRequests(fake.completedRequests)).toEqual([]);
    expect(validateDryRunAuditEvidence(ctx.audit.evidence)).toEqual({
      valid: true,
      missingSteps: [],
    });
  });

  it("페이지가 암묵적으로 final save를 시도해도 네트워크에서 abort하고 안전 오류로 분류한다", async () => {
    const fake = new FakeUriadPage(true);
    const ctx = contextFor(fake, true);

    await expect(adapter.submitApplication(ctx, submission)).rejects.toMatchObject({
      code: "dry_run_safety_violation",
      retryable: false,
    } satisfies Partial<AdapterError>);
    expect(finalSaveRequests(fake.requestAttempts)).toHaveLength(1);
    expect(finalSaveRequests(fake.completedRequests)).toEqual([]);
    expect(fake.finalSubmitClicks).toBe(0);
  });

  it("live 경로는 기존 최종 submit control과 reserved_save 요청을 유지한다", async () => {
    const fake = new FakeUriadPage();
    const ctx = contextFor(fake, false);

    const receipt = await adapter.submitApplication(ctx, submission);

    expect(receipt).toMatchObject({ dryRun: false, receiptNo: "2026-08-0001" });
    expect(fake.finalSubmitClicks).toBe(1);
    expect(finalSaveRequests(fake.completedRequests)).toHaveLength(1);
  });
});
