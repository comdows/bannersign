import { Queue, Worker, type Processor } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const QUEUE_NAMES = {
  submit: "submit",
  crawl: "crawl",
  results: "results",
  precheck: "precheck",
  notify: "notify",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return q;
}

export function createWorker(name: QueueName, processor: Processor, concurrency: number): Worker {
  return new Worker(name, processor, {
    connection,
    concurrency,
    // 잡 수준 기본 재시도 — 세부 정책은 프로세서에서 error code별로 제어
  });
}

/** 지자체별 동시성 제한: submit 큐는 전역 concurrency를 낮게 두고(2),
 *  같은 지자체 잡이 몰려도 세션은 사용자별 개별 계정이므로 세션 충돌은 없다. */
export const SUBMIT_CONCURRENCY = 2;
export const CRAWL_CONCURRENCY = 2;
