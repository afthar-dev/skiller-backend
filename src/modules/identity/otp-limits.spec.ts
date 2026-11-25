import type { Request } from "express";
import { OTP_REQUEST_LIMITS, OTP_VERIFY_LIMITS } from "./otp-limits";

const req = (email: string, ip: string) => ({ body: { email }, ip }) as unknown as Request;
const keys = (r: Request) => OTP_REQUEST_LIMITS.map((l) => l.key(r));

describe("otp limit keys", () => {
  it("a stranger's requests for an address do not share a bucket with the owner's", () => {
    expect(keys(req("Victim@x.com", "1.1.1.1"))[0]).not.toBe(keys(req("victim@x.com", "2.2.2.2"))[0]);
    expect(keys(req("Victim@x.com", "1.1.1.1"))[0]).toBe(keys(req(" victim@x.com", "1.1.1.1"))[0]);
  });

  it("addresses in one IPv6 /64 share every IP-keyed bucket", () => {
    expect(keys(req("a@x.com", "2001:db8::1"))).toEqual(keys(req("a@x.com", "2001:db8::beef")));
    expect(OTP_REQUEST_LIMITS[1].key(req("a@x.com", "2001:db8::1"))).toBe(OTP_REQUEST_LIMITS[1].key(req("b@x.com", "2001:db8::2")));
    expect(OTP_VERIFY_LIMITS[0].key(req("", "2001:db8::1"))).toBe(OTP_VERIFY_LIMITS[0].key(req("", "2001:db8::9")));
  });
});
