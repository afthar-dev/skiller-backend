import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { AUTHENTICATED_ONLY_KEY } from "../../common/auth/authenticated-only.decorator";
import { IS_PUBLIC_KEY } from "../../common/auth/public.decorator";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator";

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type Controller = Function;

const joinPath = (...parts: unknown[]) =>
  "/" +
  parts
    .flatMap((p) => (Array.isArray(p) ? [p[0]] : [p]))
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");

/**
 * Throws if any route handler of `controllers` lacks @RequirePermission, @Public or @AuthenticatedOnly (on the method or its
 * controller class). Called on bootstrap, so a forgotten decorator means the app does not start rather than shipping an open route.
 */
export function assertAllRoutesGuarded(controllers: Controller[], globalPrefix = ""): void {
  const unguarded: string[] = [];
  for (const controller of controllers) {
    const proto = (controller as { prototype: Record<string, unknown> }).prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue; // not a route

      const guarded = [IS_PUBLIC_KEY, AUTHENTICATED_ONLY_KEY, REQUIRE_PERMISSION_KEY].some(
        (key) => Reflect.getMetadata(key, handler) !== undefined || Reflect.getMetadata(key, controller) !== undefined,
      );
      if (guarded) continue;

      const path = joinPath(globalPrefix, Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler));
      unguarded.push(`${RequestMethod[method]} ${path} (${controller.name}.${name})`);
    }
  }
  if (unguarded.length > 0) {
    throw new Error(
      `Unguarded routes: every route needs @RequirePermission, @Public or @AuthenticatedOnly.\n${unguarded.map((r) => `  - ${r}`).join("\n")}`,
    );
  }
}
