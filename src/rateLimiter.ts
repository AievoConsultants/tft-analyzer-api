export class RateGate {
  private last20: number[] = [];
  private last100: number[] = [];
  constructor(
    private perSec = 20,     // dev-key: 20/sec
    private per2Min = 100,   // dev-key: 100 / 120s
    private jitterMs = 50    // tiny jitter so we don't align bursts
  ) {}

  private now() { return Date.now(); }

  private evictOld(now: number) {
    const sAgo = now - 1000;
    const tAgo = now - 120_000;
    this.last20 = this.last20.filter(t => t > sAgo);
    this.last100 = this.last100.filter(t => t > tAgo);
  }

  async wait(): Promise<void> {
    while (true) {
      const now = this.now();
      this.evictOld(now);

      if (this.last20.length < this.perSec && this.last100.length < this.per2Min) {
        this.last20.push(now);
        this.last100.push(now);
        if (this.jitterMs) await new Promise(r => setTimeout(r, Math.random() * this.jitterMs));
        return;
      }

      const next1s = (this.last20[0] ?? now) + 1000 - now;
      const next2m = (this.last100[0] ?? now) + 120_000 - now;
      const wait = Math.max(5, Math.min(next1s, next2m));
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
