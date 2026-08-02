/**
 * Dry-run safety decisions kept pure so scheduler/processor behavior can be
 * regression-tested without Redis, Supabase, or a browser.
 */
export function effectiveDryRun(...signals: Array<boolean | null | undefined>): boolean {
  return signals.some((signal) => signal === true);
}

/**
 * Upcoming windows may prepare any ready request. Once a window is already
 * open, only a request that is guaranteed to be a dry-run may catch up.
 */
export function canPrepareWindow(
  status: "upcoming" | "open" | string,
  isDryRun: boolean,
  opensAt: string,
  now: Date,
): boolean {
  const opensAtMs = Date.parse(opensAt);
  if (!Number.isFinite(opensAtMs)) return false;
  const hasOpened = status === "open" || opensAtMs <= now.getTime();
  return status === "upcoming" && !hasOpened ? true : ["upcoming", "open"].includes(status) && isDryRun;
}

export function windowRunTiming(
  opensAt: string,
  closesAt: string,
  now: Date,
): "before" | "open" | "closed" | "invalid" {
  const opensAtMs = Date.parse(opensAt);
  const closesAtMs = Date.parse(closesAt);
  if (!Number.isFinite(opensAtMs) || !Number.isFinite(closesAtMs) || opensAtMs >= closesAtMs) {
    return "invalid";
  }
  if (now.getTime() < opensAtMs) return "before";
  if (now.getTime() >= closesAtMs) return "closed";
  return "open";
}

export type MunicipalityRunBlock = "dry_run_safety_violation" | "validation_rejected";

/** Runtime guard: beta is rehearsal-only; broken/disabled/no-auto are always blocked. */
export function municipalityRunBlock(
  status: string,
  isDryRun: boolean,
  autoSubmit: boolean,
): MunicipalityRunBlock | null {
  if (status === "beta" && !isDryRun) return "dry_run_safety_violation";
  if (!["active", "beta"].includes(status) || !autoSubmit) return "validation_rejected";
  return null;
}

/** A rehearsal attempt must never be recorded as a live submission, even if the site reports a duplicate. */
export function failureTerminalStatus(
  code: string,
  windowStillOpen: boolean,
  isDryRun: boolean,
): "submitted" | "needs_manual" | "failed" {
  if (code === "already_submitted") return isDryRun ? "needs_manual" : "submitted";
  if (["audit_incomplete", "dry_run_safety_violation"].includes(code) || windowStillOpen) {
    return "needs_manual";
  }
  return "failed";
}
