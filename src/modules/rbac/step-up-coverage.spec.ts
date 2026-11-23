import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RequestMethod } from "@nestjs/common";
import { StepUpGuard } from "../identity";
import { REQUIRE_PERMISSION_KEY, type RequirePermissionMeta } from "./require-permission.decorator";

const SRC = join(__dirname, "..", "..");

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return name.endsWith(".controller.ts") ? [full] : [];
  });
}

/** Permissions that change who can do what, or platform-wide behaviour: every write behind one needs a fresh step-up. */
const PRIVILEGE_PERMISSION = /^(rbac|role|settings|flags)\.|^user\.(suspend|revoke_sessions)$/;
const WRITE_METHODS = new Set([RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE]);

describe("step-up coverage", () => {
  it("every write route behind a privilege-changing permission carries the step-up guard", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of controllerFiles(SRC)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(file) as Record<string, unknown>;
      for (const exported of Object.values(mod)) {
        if (typeof exported !== "function" || !Reflect.getMetadata("path", exported)) continue;
        const proto = (exported as { prototype: object }).prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = (proto as Record<string, unknown>)[name];
          if (name === "constructor" || typeof handler !== "function") continue;
          const method = Reflect.getMetadata("method", handler) as RequestMethod | undefined;
          if (method === undefined || !WRITE_METHODS.has(method)) continue;
          const perm = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as RequirePermissionMeta | undefined;
          if (!perm || !PRIVILEGE_PERMISSION.test(perm.key)) continue;
          checked++;
          const guards = [...((Reflect.getMetadata("__guards__", handler) as unknown[] | undefined) ?? []), ...((Reflect.getMetadata("__guards__", exported) as unknown[] | undefined) ?? [])];
          if (!guards.includes(StepUpGuard)) missing.push(`${(exported as { name: string }).name}.${name} (${perm.key})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
});
