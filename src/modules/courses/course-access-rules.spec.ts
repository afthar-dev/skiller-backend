import type { PlatformRoleDirectory } from "../rbac";
import { CourseAccessRules } from "./course-access-rules";

const userCourse = { id: "c1", ownerType: "USER" as const, ownerId: "owner" };
const orgCourse = { id: "c2", ownerType: "ORG" as const, ownerId: "org1" };

function make(opts: { enrolled?: boolean; orgRoles?: string[] } = {}) {
  const prisma = { enrolment: { findFirst: async () => (opts.enrolled ? { id: "e1" } : null) } };
  const roles = { roleKeysInOrg: async () => opts.orgRoles ?? [] } as unknown as PlatformRoleDirectory;
  return new CourseAccessRules(prisma as never, roles);
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
      return new CourseAccessRules(prisma as never, { roleKeysInOrg: async () => orgRoles } as unknown as PlatformRoleDirectory);
    };
    expect(await rules(["org_learner"]).hasLiveSeat("u", "c2")).toBe(true);
    expect(await rules([]).hasLiveSeat("u", "c2")).toBe(false);
    expect(await rules(["org_learner"]).hasLiveSeat("u", "c1")).toBe(false);
    expect(await rules(["org_learner"]).hasLiveSeat("u", "missing")).toBe(false);
  });
});
