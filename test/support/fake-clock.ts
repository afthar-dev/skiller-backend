import type { Clock } from "../../src/common/clock/clock";

export class FakeClock implements Clock {
  constructor(private current = new Date()) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceSec(sec: number) {
    this.advance(sec * 1000);
  }
}
