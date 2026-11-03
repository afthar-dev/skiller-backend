import { Controller, Get, Post } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { PLATFORM_PERMISSION_KEYS } from "./permissions";
import { PermissionRegistry, definePermissions } from "./permission.registry";
import { RequirePermission } from "./require-permission.decorator";
import { assertAllRoutesGuarded } from "./route-guard-check";

describe("PermissionRegistry / definePermissions", () => {
  it("returns typed key constants and registers each key with its module and description", () => {
    const registry = new PermissionRegistry();
    const keys = definePermissions("widget", { view: "View widgets", edit: "Edit widgets" }, registry);
    const view: "widget.view" = keys.view;
    expect(view).toBe("widget.view");
    expect(keys.edit).toBe("widget.edit");
    expect(registry.all()).toEqual([
      { key: "widget.view", module: "widget", description: "View widgets" },
      { key: "widget.edit", module: "widget", description: "Edit widgets" },
    ]);
  });

  it("rejects defining the same key twice", () => {
    const registry = new PermissionRegistry();
    definePermissions("dup", { a: "A" }, registry);
    expect(() => definePermissions("dup", { a: "A again" }, registry)).toThrow(/dup\.a/);
  });

  it("defines exactly the Phase-1 and Phase-2 keys in the default registry", () => {
    expect([...PLATFORM_PERMISSION_KEYS].sort()).toEqual(
      [
        "profile.update_any", "user.view", "user.suspend", "user.revoke_sessions", "rbac.view", "rbac.manage", "role.grant", "audit.view",
        "media.upload", "media.manage_any", "org.create", "org.manage", "org.invite", "settings.manage", "flags.manage", "notification.view",
        "billing.plans.manage", "billing.view_any", "billing.refund", "billing.coupons.manage", "finance.view", "payout.approve", "wallet.view_any",
      ].sort(),
    );
  });
});

describe("assertAllRoutesGuarded", () => {
  @Controller("ok")
  class OkController {
    @Get("a") @RequirePermission("user.view") a() {}
    @Get("b") @Public() b() {}
    @Get("c") @AuthenticatedOnly() c() {}
  }

  @Public()
  @Controller("class-public")
  class ClassPublicController {
    @Get() x() {}
  }

  @AuthenticatedOnly()
  @Controller("class-auth")
  class ClassAuthController {
    @Post() x() {}
  }

  @Controller("leaky")
  class LeakyController {
    @Get("guarded") @RequirePermission("user.view") guarded() {}
    @Post("open-door") openDoor() {}
    helper() {} // not a route
  }

  it("passes when every route carries @RequirePermission, @Public or @AuthenticatedOnly (method or class level)", () => {
    expect(() => assertAllRoutesGuarded([OkController, ClassPublicController, ClassAuthController], "v1")).not.toThrow();
  });

  it("throws naming the unguarded route", () => {
    expect(() => assertAllRoutesGuarded([OkController, LeakyController], "v1")).toThrow(/POST \/v1\/leaky\/open-door/);
    expect(() => assertAllRoutesGuarded([LeakyController], "v1")).toThrow(/LeakyController\.openDoor/);
  });
});
