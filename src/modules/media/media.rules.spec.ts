import { AppError } from "../../common/errors/app-error";
import { MEDIA_RULES, PART_SIZE, requiresCreator, validateUpload } from "./media.rules";

const MB = 1024 * 1024;
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : "OTHER";
  }
  return null;
};

describe("MEDIA_RULES", () => {
  it("matches the plan's global constraints", () => {
    for (const p of ["AVATAR", "BANNER", "THUMBNAIL", "GIG_GALLERY"] as const) {
      expect(MEDIA_RULES[p]).toMatchObject({ bucket: "PUBLIC", kind: "image", maxBytes: 10 * MB });
    }
    expect(MEDIA_RULES.REEL).toMatchObject({ bucket: "PUBLIC", kind: "video", maxBytes: 200 * MB, maxDurationSec: 90 });
    expect(MEDIA_RULES.COURSE_LESSON).toMatchObject({ bucket: "PRIVATE", kind: "video", maxBytes: 5 * 1024 * MB });
    expect(MEDIA_RULES.COURSE_PROMO).toMatchObject({ bucket: "PUBLIC", kind: "video", maxBytes: 500 * MB, maxDurationSec: 300 });
    expect(MEDIA_RULES.COURSE_RESOURCE).toMatchObject({ bucket: "PRIVATE", kind: "file", maxBytes: 100 * MB });
    expect(MEDIA_RULES.COURSE_RESOURCE.mimes).toEqual(expect.arrayContaining(["application/pdf", "application/zip"]));
    expect(PART_SIZE).toBe(10 * MB);
  });

  it("only reels, lessons and resources need a creator", () => {
    expect(requiresCreator("REEL")).toBe(true);
    expect(requiresCreator("COURSE_LESSON")).toBe(true);
    expect(requiresCreator("COURSE_RESOURCE")).toBe(true);
    expect(requiresCreator("COURSE_PROMO")).toBe(true);
    expect(requiresCreator("AVATAR")).toBe(false);
    expect(requiresCreator("GIG_GALLERY")).toBe(false);
  });
});

describe("validateUpload", () => {
  it("accepts a valid avatar", () => {
    expect(codeOf(() => validateUpload("AVATAR", "image/png", 2 * MB))).toBeNull();
    expect(codeOf(() => validateUpload("AVATAR", "image/png", 10 * MB))).toBeNull();
  });

  it("rejects an 11 MB avatar with MEDIA_TOO_LARGE", () => {
    expect(codeOf(() => validateUpload("AVATAR", "image/png", 11 * MB))).toBe("MEDIA_TOO_LARGE");
  });

  it("rejects an image/gif reel with MEDIA_TYPE_NOT_ALLOWED", () => {
    expect(codeOf(() => validateUpload("REEL", "image/gif", MB))).toBe("MEDIA_TYPE_NOT_ALLOWED");
  });

  it("rejects a 201 MB reel and a 101 MB resource", () => {
    expect(codeOf(() => validateUpload("REEL", "video/mp4", 201 * MB))).toBe("MEDIA_TOO_LARGE");
    expect(codeOf(() => validateUpload("COURSE_PROMO", "video/mp4", 500 * MB))).toBeNull();
    expect(codeOf(() => validateUpload("COURSE_PROMO", "video/mp4", 501 * MB))).toBe("MEDIA_TOO_LARGE");
    expect(codeOf(() => validateUpload("COURSE_RESOURCE", "application/pdf", 101 * MB))).toBe("MEDIA_TOO_LARGE");
  });

  it("rejects empty and non-integer sizes", () => {
    expect(codeOf(() => validateUpload("AVATAR", "image/png", 0))).toBe("VALIDATION_FAILED");
    expect(codeOf(() => validateUpload("AVATAR", "image/png", 1.5))).toBe("VALIDATION_FAILED");
  });
});
