import { logger } from "./logger.js";
import { processCrawlJob } from "./processors/crawl.js";
import { processNotifyBatch } from "./processors/notify.js";
import { processPrecheckJob } from "./processors/precheck.js";
import { processResultsJob } from "./processors/results.js";
import { processSubmitJob } from "./processors/submit.js";
import { createWorker, CRAWL_CONCURRENCY, SUBMIT_CONCURRENCY, getQueue } from "./queues.js";
import { startScheduler } from "./scheduler.js";
import { startServer } from "./server.js";

const workers = [
  createWorker("submit", processSubmitJob, SUBMIT_CONCURRENCY),
  createWorker("crawl", processCrawlJob, CRAWL_CONCURRENCY),
  createWorker("precheck", processPrecheckJob, 1),
  createWorker("results", processResultsJob, 1),
  createWorker("notify", processNotifyBatch, 1),
];

for (const w of workers) {
  w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, err }, "job failed"));
}

// 알림 디스패처: 1분 주기 repeatable
await getQueue("notify").add(
  "notify-batch",
  { kind: "notify", notificationId: "00000000-0000-0000-0000-000000000000" },
  { repeat: { every: 60_000 }, jobId: "notify-batch" },
);

const schedulerHandle = startScheduler();
startServer();

logger.info("worker started");

async function shutdown(): Promise<void> {
  clearInterval(schedulerHandle);
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
