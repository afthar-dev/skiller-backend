import { generateHandle, HANDLE_PATTERN, isReservedHandle, normalizeHandle } from "./handles";

describe("handles", () => {
  it("normalises case, whitespace and a leading @", () => {
    expect(normalizeHandle("  @Aftab ")).toBe("aftab");
    expect(normalizeHandle("MiXeD_1")).toBe("mixed_1");
  });

  it("flags the reserved list case-insensitively once normalised", () => {
    for (const h of ["admin", "api", "skiller", "support", "settings", "me", "v1"]) expect(isReservedHandle(normalizeHandle(h.toUpperCase()))).toBe(true);
    expect(isReservedHandle("aftab")).toBe(false);
  });

  it("generates a valid handle from any email local part", () => {
    for (const email of ["aftab@example.com", "A.B+tag@example.com", "x@example.com", "...@example.com", `${"long".repeat(20)}@example.com`, "ünï@example.com"]) {
      const h = generateHandle(email);
      expect(h).toMatch(HANDLE_PATTERN);
      expect(isReservedHandle(h)).toBe(false);
    }
    expect(generateHandle("aftab@example.com")).toMatch(/^aftab\d{4}$/);
  });
});
