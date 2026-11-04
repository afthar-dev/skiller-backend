import { definePermissions } from "../rbac/permission.registry";

export const CoursePermissions = definePermissions("course", {
  create: "Create courses (creators; organization authors are checked by the course policy)",
  review: "Review, approve, reject and unpublish courses",
  manage_any: "Author-level access to every course (override for moderators and admins)",
  "categories.manage": "Manage course categories",
});
