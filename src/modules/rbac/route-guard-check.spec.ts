import { Controller, Get } from "@nestjs/common";
import { OptionalAuth } from "../../common/auth/optional-auth.decorator";
import { assertAllRoutesGuarded } from "./route-guard-check";

@Controller("x")
class Guarded {
  @OptionalAuth()
  @Get("a")
  a() {}
}

@Controller("y")
class Unguarded {
  @Get("b")
  b() {}
}

describe("assertAllRoutesGuarded", () => {
  it("accepts @OptionalAuth as a guard declaration", () => {
    expect(() => assertAllRoutesGuarded([Guarded])).not.toThrow();
  });

  it("still refuses a route with no declaration", () => {
    expect(() => assertAllRoutesGuarded([Unguarded])).toThrow(/GET \/y\/b/);
  });
});
