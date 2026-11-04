import type { PermissionService, PlatformRoleDirectory } from "../rbac";

const noPerms = { has: async () => false } as unknown as PermissionService;
import { CourseAccessRules } from "./course-access-rules";

const userCourse = { id: "c1", ownerType: "USER" as const, ownerId: "owner" };
const orgCourse = { id: "c2", ownerType: "ORG" as const, ownerId: "org1" };

function make(opts: { enrolled?: boolean; orgRoles?: string[] } = {}) {
  const prisma = { enrolment: { findFirst: async () => (opts.enrolled ? { id: "e1" } : null) } };
  const roles = { roleKeysInOrg: async () => opts.orgRoles ?? [] } as unknown as PlatformRoleDirectory;
  return new CourseAccessRules(prisma as never, roles, noPerms);
}

describe("CourseAccessRules.buyerRelation", () => {
  it("OWN for the owner of a user course, even when enrolled", async () => {
    expect(await make({ enrolled: true }).buyerRelation("owner", userCourse)).toBe("OWN");
  });
  it("NONE for anyone else, ENROLLED once they hold an active enrolment", async () => {
    expect(await make().buyerRelation("u", userCourse)).toBe("NONE");
    expect(await make({ enrolled: true }).buyerRelation("u", userCourse)).toBe("ENROLLED");
  });
  it.each(["org_owner", "org_instructor"])("ORG_AUTHOR for %s of the owning organization", async (role) => {
    expect(await make({ orgRoles: [role, "org_learner"] }).buyerRelation("u", orgCourse)).toBe("ORG_AUTHOR");
  });
  it("ORG_LEARNER for a learner, but an enrolled learner is ENROLLED", async () => {
    expect(await make({ orgRoles: ["org_learner"] }).buyerRelation("u", orgCourse)).toBe("ORG_LEARNER");
    expect(await make({ orgRoles: ["org_learner"], enrolled: true }).buyerRelation("u", orgCourse)).toBe("ENROLLED");
  });
  it("NONE for a member with another org role", async () => {
    expect(await make({ orgRoles: ["something_else"] }).buyerRelation("u", orgCourse)).toBe("NONE");
  });
});

describe("CourseAccessRules.hasLiveSeat", () => {
  it("is true only for a live org_learner grant in the owning organization of an org course", async () => {
    const rules = (orgRoles: string[]) => {
      const prisma = { course: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === "c2" ? orgCourse : where.id === "c1" ? userCourse : null) } };
      return new CourseAccessRules(prisma as never, { roleKeysInOrg: async () => orgRoles } as unknown as PlatformRoleDirectory, noPerms);
    };
    expect(await rules(["org_learner"]).hasLiveSeat("u", "c2")).toBe(true);
    expect(await rules([]).hasLiveSeat("u", "c2")).toBe(false);
    expect(await rules(["org_learner"]).hasLiveSeat("u", "c1")).toBe(false);
    expect(await rules(["org_learner"]).hasLiveSeat("u", "missing")).toBe(false);
  });
});

describe("CourseAccessRules.learnAccess", () => {
  const published = { ...userCourse, status: "PUBLISHED" as const, flaggedAt: null };
  const seatCourse = { ...orgCourse, status: "PUBLISHED" as const, flaggedAt: null };
  function make(opts: { enrolment?: "PURCHASE" | "ORG_SEAT"; orgRoles?: string[]; perms?: string[] } = {}) {
    const prisma = { enrolment: { findFirst: async () => (opts.enrolment ? { id: "e1", source: opts.enrolment } : null) } };
    const roles = { roleKeysInOrg: async () => opts.orgRoles ?? [] } as unknown as PlatformRoleDirectory;
    const perms = { has: async (_u: string, key: string) => (opts.perms ?? []).includes(key) } as unknown as PermissionService;
    return new CourseAccessRules(prisma as never, roles, perms);
  }

  it("an enrolment counts for progress; an ORG_SEAT one only while the org_learner grant is live", async () => {
    expect(await make({ enrolment: "PURCHASE" }).learnAccess("u", published)).toEqual({ via: "ENROLLED", progress: true });
    expect(await make({ enrolment: "ORG_SEAT", orgRoles: ["org_learner"] }).learnAccess("u", seatCourse)).toEqual({ via: "ENROLLED", progress: true });
    expect(await make({ enrolment: "ORG_SEAT", orgRoles: [] }).learnAccess("u", seatCourse)).toBeNull();
  });
  it("authors and course.manage_any get in without progress", async () => {
    expect(await make().learnAccess("owner", published)).toEqual({ via: "AUTHOR", progress: false });
    expect(await make({ perms: ["course.manage_any"] }).learnAccess("u", published)).toEqual({ via: "AUTHOR", progress: false });
  });
  it("a free-preview lesson of a published, unflagged course is open to anyone, never for progress", async () => {
    expect(await make().learnAccess("u", published, { isFreePreview: true })).toEqual({ via: "PREVIEW", progress: false });
    expect(await make().learnAccess("u", published, { isFreePreview: false })).toBeNull();
    expect(await make().learnAccess("u", published)).toBeNull();
    expect(await make().learnAccess("u", { ...published, flaggedAt: new Date() }, { isFreePreview: true })).toBeNull();
    expect(await make().learnAccess("u", { ...published, status: "ARCHIVED" }, { isFreePreview: true })).toBeNull();
  });
  it("course.review sees in-review, published and flagged courses, not drafts", async () => {
    const m = make({ perms: ["course.review"] });
    expect(await m.learnAccess("u", { ...published, status: "IN_REVIEW" })).toEqual({ via: "REVIEW", progress: false });
    expect(await m.learnAccess("u", { ...published, status: "DRAFT", flaggedAt: new Date() })).toEqual({ via: "REVIEW", progress: false });
    expect(await m.learnAccess("u", { ...published, status: "DRAFT" })).toBeNull();
  });
});
