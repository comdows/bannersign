import { createServer } from "node:http";
import { enqueueRequestSchema } from "@youni/core";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { getQueue, type QueueName } from "./queues.js";

/**
 * web → worker 내부 HTTP 엔드포인트.
 * POST /enqueue  { payload: AnyJobPayload, runAt?: epochMs }  (Authorization: Bearer <shared secret>)
 * GET  /healthz
 */
export function startServer(): void {
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/enqueue") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${env.WORKER_SHARED_SECRET}`) {
      res.writeHead(401).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    try {
      const body = enqueueRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const queueName: QueueName = body.payload.kind === "submit" ? "submit" : body.payload.kind;
      const delay = body.runAt ? Math.max(0, body.runAt - Date.now()) : 0;
      const job = await getQueue(queueName).add(body.payload.kind, body.payload, { delay });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jobId: job.id }));
    } catch (err) {
      logger.warn({ err }, "enqueue rejected");
      res.writeHead(400).end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(env.PORT, () => logger.info({ port: env.PORT }, "worker http listening"));
}
