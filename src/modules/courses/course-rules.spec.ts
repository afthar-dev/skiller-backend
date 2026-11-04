import { assertValidCoursePrice, firstFreeSlug, randomSlug, slugify } from "./course-rules";

describe("course price", () => {
  it.each([0n, 9_900n, 10_000_000n])("accepts %s", (p) => expect(() => assertValidCoursePrice(p)).not.toThrow());
  it.each([1n, 5_000n, 9_899n, 10_000_001n])("rejects %s", (p) => expect(() => assertValidCoursePrice(p)).toThrow(expect.objectContaining({ code: "COURSE_PRICE_INVALID" })));
});

describe("slugs", () => {
  it("folds accents and punctuation into kebab-case", () => {
    expect(slugify("  Café Crème: Learn C++ & Go!  ")).toBe("cafe-creme-learn-c-go");
  });
  it("returns empty for non-Latin titles so callers fall back to a random slug", () => {
    expect(slugify("पायथन सीखें")).toBe("");
    expect(randomSlug()).toMatch(/^course-[a-z0-9]{6}$/);
  });
  it("caps the length without a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(59)} bbb`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
  it("picks the first free numeric suffix", () => {
    expect(firstFreeSlug("rust", new Set())).toBe("rust");
    expect(firstFreeSlug("rust", new Set(["rust", "rust-2"]))).toBe("rust-3");
  });
});
