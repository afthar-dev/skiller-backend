import { Global, Module } from "@nestjs/common";

export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Injectable time source so expiry windows (OTP, refresh race, step-up) are testable without fake timers. */
@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
