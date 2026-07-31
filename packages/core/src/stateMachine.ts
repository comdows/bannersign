import type { SubmissionJobStatus } from "./types.js";

/**
 * submission_jobs 상태 머신.
 * 워커/웹 어디서든 상태 변경 전 assertTransition으로 검증해
 * 레이스로 인한 역행(submitted → running 등)을 방지한다.
 */
const TRANSITIONS: Record<SubmissionJobStatus, SubmissionJobStatus[]> = {
  pending: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["awaiting_captcha", "submitted", "failed", "needs_manual", "queued"],
  awaiting_captcha: ["running", "needs_manual", "failed", "cancelled"],
  needs_manual: ["queued", "submitted", "cancelled"],
  submitted: [],
  failed: ["queued"], // 운영자 수동 재시도
  cancelled: [],
};

export function canTransition(from: SubmissionJobStatus, to: SubmissionJobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SubmissionJobStatus, to: SubmissionJobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid submission_job transition: ${from} -> ${to}`);
  }
}

export const TERMINAL_STATUSES: SubmissionJobStatus[] = ["submitted", "cancelled"];

/**
 * 자동 제출을 "시작해도 되는" 잡 상태 (S04).
 *
 * BullMQ 의 delayed 제출 잡은 창구 오픈 시각까지 큐에 떠 있다가 뒤늦게 도착한다.
 * 그 사이 D-1 사전 점검이 잡을 needs_manual 로 돌렸을 수 있고, 운영자가 cancelled
 * 로 바꿨을 수도 있다. 저장된 상태가 pending/queued 가 아니면 제출 프로세서는
 * 아무 것도 하지 않는다 — needs_manual 이 자동으로 제출되는 경로를 없앤다.
 */
export const SUBMITTABLE_STATUSES: SubmissionJobStatus[] = ["pending", "queued"];

/** DB 에 저장된 현재 status 로 자동 제출을 시작할 수 있는가 (알 수 없는 값은 false) */
export function canStartSubmission(status: string): boolean {
  return (SUBMITTABLE_STATUSES as string[]).includes(status);
}
