import { ipKey } from "./ip-key";

describe("ipKey", () => {
  it("leaves IPv4 alone and unwraps IPv4-mapped IPv6", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("buckets IPv6 by /64: addresses in one /64 share a key, other /64s do not", () => {
    expect(ipKey("2001:db8::1")).toBe(ipKey("2001:db8::ffff"));
    expect(ipKey("2001:db8:0:0:aaaa:bbbb:cccc:dddd")).toBe(ipKey("2001:db8::1"));
    expect(ipKey("2001:db8:0:1::1")).not.toBe(ipKey("2001:db8::1"));
    expect(ipKey("2001:DB8::1")).toBe(ipKey("2001:db8::1"));
  });

  it("does not throw on junk and keeps unknown as is", () => {
    expect(ipKey(undefined)).toBe("unknown");
    expect(ipKey("not an ip")).toBe("not an ip");
  });
});
