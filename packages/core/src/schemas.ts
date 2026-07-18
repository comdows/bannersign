import { z } from "zod";

/** BullMQ 잡 페이로드 — web/worker 간 계약. 반드시 이 스키마로 파싱 후 사용. */

export const submitJobPayloadSchema = z.object({
  kind: z.literal("submit"),
  submissionJobId: z.string().uuid(),
  /** dry-run이면 최종 제출 버튼 직전까지만 수행 */
  dryRun: z.boolean().default(false),
});
export type SubmitJobPayload = z.infer<typeof submitJobPayloadSchema>;

export const crawlJobPayloadSchema = z.object({
  kind: z.literal("crawl"),
  municipalityId: z.string().uuid(),
  target: z.enum(["boards", "schedule", "spec", "health"]),
});
export type CrawlJobPayload = z.infer<typeof crawlJobPayloadSchema>;

export const resultsJobPayloadSchema = z.object({
  kind: z.literal("results"),
  windowId: z.string().uuid(),
});
export type ResultsJobPayload = z.infer<typeof resultsJobPayloadSchema>;

export const precheckJobPayloadSchema = z.object({
  kind: z.literal("precheck"),
  /** 창구 D-1 사전 점검: 로그인 테스트 + healthCheck */
  windowId: z.string().uuid(),
});
export type PrecheckJobPayload = z.infer<typeof precheckJobPayloadSchema>;

export const notifyJobPayloadSchema = z.object({
  kind: z.literal("notify"),
  notificationId: z.string().uuid(),
});
export type NotifyJobPayload = z.infer<typeof notifyJobPayloadSchema>;

export const anyJobPayloadSchema = z.discriminatedUnion("kind", [
  submitJobPayloadSchema,
  crawlJobPayloadSchema,
  resultsJobPayloadSchema,
  precheckJobPayloadSchema,
  notifyJobPayloadSchema,
]);
export type AnyJobPayload = z.infer<typeof anyJobPayloadSchema>;

/** worker /enqueue 엔드포인트 요청 바디 */
export const enqueueRequestSchema = z.object({
  payload: anyJobPayloadSchema,
  /** epoch ms — 이 시각 이후에 실행 (delayed job) */
  runAt: z.number().int().positive().optional(),
});
export type EnqueueRequest = z.infer<typeof enqueueRequestSchema>;

/** AI 시안 검증 structured output */
export const designFindingSchema = z.object({
  ruleId: z.string(),
  result: z.enum(["pass", "warn", "fail"]),
  reasonKo: z.string(),
});

export const designValidationResultSchema = z.object({
  verdict: z.enum(["pass", "warn", "fail"]),
  findings: z.array(designFindingSchema),
});
