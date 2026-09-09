/**
 * Tracks consecutive failures so a notification fires only after a threshold is
 * reached, avoiding alert spam on transient blips while still surfacing
 * persistent problems.
 */
export class ConsecutiveFailureTracker {
  private count = 0;

  /** Record a result; returns the current consecutive-failure count. */
  record(ok: boolean): number {
    this.count = ok ? 0 : this.count + 1;
    return this.count;
  }

  /** True when the consecutive-failure count has reached `alertAfter`. */
  shouldAlert(alertAfter: number): boolean {
    return this.count >= alertAfter;
  }

  /** Reset the counter (e.g. after an alert has been delivered). */
  reset(): void {
    this.count = 0;
  }
}
