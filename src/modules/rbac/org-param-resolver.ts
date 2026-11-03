import { Injectable } from "@nestjs/common";

export type OrgParamResolver = (value: string) => Promise<string | null>;

/**
 * Lets the module that owns organizations turn a route param (e.g. an org slug) into an org id for @RequirePermission's
 * `orgParam`, so RBAC never touches the organizations table. Params without a registered resolver are taken to be org ids.
 */
@Injectable()
export class OrgParamResolverRegistry {
  private readonly resolvers = new Map<string, OrgParamResolver>();

  register(paramName: string, resolver: OrgParamResolver): void {
    this.resolvers.set(paramName, resolver);
  }

  /** `undefined` means the param names an org that does not exist: only platform-wide grants can then pass. */
  async resolve(paramName: string, value: string): Promise<string | undefined> {
    const resolver = this.resolvers.get(paramName);
    if (!resolver) return value;
    return (await resolver(value)) ?? undefined;
  }
}
