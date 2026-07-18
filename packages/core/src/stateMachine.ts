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
