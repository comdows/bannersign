import { AdapterError } from "../types.js";

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * 어댑터 내부의 짧은 재시도(요소 대기, 일시 오류)용.
 * 잡 수준의 긴 재시도(지수 백오프 1m→3h)는 worker의 BullMQ 정책이 담당한다.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = { attempts: 3, baseDelayMs: 500, maxDelayMs: 5000 },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof AdapterError && !err.retryable) throw err;
      const delay = Math.min(opts.baseDelayMs * 2 ** i, opts.maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
