/** 지자체 코드 — adapters 레지스트리 키와 1:1 */
export type MunicipalityKey = string;

export type MunicipalityStatus = "active" | "beta" | "broken" | "disabled";

export type CaptchaType = "none" | "image" | "unknown";

export interface MunicipalityCapabilities {
  autoSubmit: boolean;
  onlinePayment: boolean;
  captchaType: CaptchaType;
}

export type SelectionMethod = "lottery" | "fcfs";

export interface BoardSiteInfo {
  externalId: string;
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  slotCount?: number;
  fee?: number;
  dimensionsCm?: { width: number; height: number };
  raw?: Record<string, unknown>;
}

export interface ApplicationWindowInfo {
  opensAt: string; // ISO
  closesAt: string;
  targetPeriodStart: string; // 게시 대상 기간
  targetPeriodEnd: string;
  selectionMethod: SelectionMethod;
  resultExpectedAt?: string;
}

/** 지자체 시안 규격 (municipality_specs.spec) */
export interface DesignSpec {
  sizeCm: { width: number; height: number };
  /** 비율 허용 오차 (0.02 = ±2%) */
  ratioTolerance: number;
  fileFormats: string[]; // ["jpg", "jpeg", "png"]
  maxFileMb?: number;
  colorRules?: string[]; // 자연어 규칙 (프롬프트 주입용)
  requiredTexts?: string[]; // 예: "게시기간 표기"
  prohibited?: string[]; // 금지 콘텐츠 규칙
  notes?: string[];
}

/** "매월 1~5일 접수" 류의 창구 생성 규칙 (municipality_specs.window_rule) */
export interface WindowRule {
  /** 매월 접수 시작일 (1 = 1일) */
  openDayOfMonth: number;
  /** 매월 접수 마감일 */
  closeDayOfMonth: number;
  /** 오픈 시각 "HH:mm" (사이트 공지 기준, 불확실하면 "00:00") */
  openTime: string;
  closeTime: string;
  timezone: "Asia/Seoul";
  /** 신청 대상: 다음 달 게시분 등 */
  targetMonthOffset: number;
  selectionMethod: SelectionMethod;
  /** 결과 발표 예상: 창구 마감 후 N일 */
  resultAfterCloseDays?: number;
}

export type SubmissionJobStatus =
  | "pending" // window 감지, 잡 레코드 생성됨
  | "queued" // BullMQ delayed job 등록됨
  | "running"
  | "awaiting_captcha"
  | "needs_manual"
  | "submitted"
  | "dry_run_completed"
  | "failed"
  | "cancelled";

export type SubmissionErrorCode =
  | "network"
  | "site_down"
  | "not_open_yet"
  | "login_failed"
  | "captcha_timeout"
  | "selector_missing"
  | "boards_full"
  | "already_submitted"
  | "validation_rejected"
  | "audit_incomplete"
  | "dry_run_safety_violation"
  | "unknown";

/** 제출 리허설의 단계별 감사 증적. 경로는 private audit Storage 내부 경로다. */
export interface SubmissionAuditEvent {
  step: string;
  /** query string을 제거한 페이지 URL */
  url: string;
  /** 증적을 캡처한 UTC ISO 시각 */
  capturedAt: string;
  screenshotPath: string | null;
  htmlPath: string | null;
}

export interface BoardPreference {
  boardSiteId: string;
  priority: number; // 1이 최우선
}

export type NotificationType =
  | "window_upcoming"
  | "window_open"
  | "precheck_failed"
  | "submit_ok"
  | "submit_fail"
  | "captcha_needed"
  | "needs_manual"
  | "result_selected"
  | "result_rejected";

export type NotificationChannel = "email" | "webpush" | "alimtalk";

export type DesignVerdict = "pass" | "warn" | "fail";

export interface DesignFinding {
  ruleId: string;
  result: DesignVerdict;
  reasonKo: string;
}

export interface DesignValidationResult {
  verdict: DesignVerdict;
  findings: DesignFinding[];
}
