import type {
  ApplicationWindowInfo,
  BoardPreference,
  BoardSiteInfo,
  CaptchaType,
  DesignSpec,
  SubmissionErrorCode,
  WindowRule,
} from "@youni/core";
import type { Page } from "playwright";

export interface AdapterMeta {
  /** municipalities.adapter_key와 일치 */
  key: string;
  nameKo: string;
  siteUrl: string;
  captchaType: CaptchaType;
  autoSubmit: boolean;
  onlinePayment: boolean;
}

/** 매 단계 스크린샷/HTML 스냅샷을 남기는 감사 훅 — 어댑터는 의미 단계마다 호출해야 한다(계약). */
export interface AuditTrail {
  step(name: string): Promise<void>;
  /** 지금까지 기록된 단계 이름들 */
  readonly steps: string[];
}

export interface CrawlContext {
  page: Page;
  audit: AuditTrail;
  log: (msg: string) => void;
}

export interface DecryptedCredential {
  username: string;
  password: string;
}

export interface SubmitContext extends CrawlContext {
  /** true면 최종 제출 버튼 직전까지만 수행하고 중단 */
  dryRun: boolean;
  /**
   * 캡차 이미지 발견 시 호출 — 이미지를 릴레이 UI로 보내고 사용자의 답을 기다린다.
   * 타임아웃 시 CaptchaTimeoutError를 던진다.
   */
  onCaptcha: (imageBuffer: Buffer) => Promise<string>;
}

export interface SubmissionInput {
  profile: {
    businessName: string;
    bizRegNo?: string;
    representative?: string;
    phone: string;
    email?: string;
    address?: string;
  };
  /** 우선순위 정렬된 게시대 external_id 목록 */
  boardPreferences: Array<BoardPreference & { externalId: string; boardName: string }>;
  designFilePath: string;
  targetPeriod: { start: string; end: string };
}

export interface SubmissionReceipt {
  receiptNo?: string;
  selectedBoardExternalId?: string;
  submittedAt: string;
  /** dry-run이면 true — 실제 제출은 일어나지 않음 */
  dryRun: boolean;
}

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  failures: Array<{ check: string; detail: string }>;
}

export interface SpecDraft {
  spec: Partial<DesignSpec>;
  windowRule?: Partial<WindowRule>;
  sourceUrl: string;
  /** 크롤 원문 — 관리자 검수 화면에서 대조용 */
  rawText: string;
}

export interface WindowRef {
  opensAt: string;
  closesAt: string;
  targetPeriodStart: string;
}

export interface ResultRowDraft {
  boardExternalId?: string;
  applicantName?: string;
  receiptNo?: string;
  outcome: "selected" | "rejected" | "unknown";
  raw: Record<string, unknown>;
}

/**
 * 지자체 어댑터 플러그인 인터페이스.
 * 신규 지자체 = 이 인터페이스 구현 + registry 등록 + municipalities 레코드 + 픽스처 테스트.
 */
export interface MunicipalityAdapter {
  readonly meta: AdapterMeta;

  fetchBoards(ctx: CrawlContext): Promise<BoardSiteInfo[]>;
  fetchSchedule(ctx: CrawlContext): Promise<ApplicationWindowInfo[]>;
  fetchSpec(ctx: CrawlContext): Promise<SpecDraft>;
  fetchResults(ctx: CrawlContext, window: WindowRef): Promise<ResultRowDraft[]>;

  login(ctx: SubmitContext, cred: DecryptedCredential): Promise<void>;
  healthCheck(ctx: CrawlContext): Promise<HealthReport>;
  submitApplication(ctx: SubmitContext, input: SubmissionInput): Promise<SubmissionReceipt>;
}

/** 어댑터가 던지는 분류된 오류 — worker 재시도 정책이 error code로 분기한다. */
export class AdapterError extends Error {
  constructor(
    public readonly code: SubmissionErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class CaptchaTimeoutError extends AdapterError {
  constructor() {
    super("captcha_timeout", "captcha relay timed out", true);
    this.name = "CaptchaTimeoutError";
  }
}
