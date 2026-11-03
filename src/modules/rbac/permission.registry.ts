export interface PermissionDef {
  key: string;
  module: string;
  description: string;
}

/** In-memory list of every permission the code knows about. Filled at import time by definePermissions(). */
export class PermissionRegistry {
  private readonly defs = new Map<string, PermissionDef>();

  register(def: PermissionDef): void {
    if (this.defs.has(def.key)) throw new Error(`Permission "${def.key}" is defined twice`);
    this.defs.set(def.key, { ...def });
  }

  has(key: string): boolean {
    return this.defs.has(key);
  }

  all(): PermissionDef[] {
    return [...this.defs.values()];
  }
}

export const permissionRegistry = new PermissionRegistry();

/**
 * definePermissions("media", { upload: "Upload media" }) registers "media.upload" and returns { upload: "media.upload" }
 * with literal key types, so call sites use constants instead of strings.
 */
export function definePermissions<const M extends string, const P extends Record<string, string>>(
  module: M,
  perms: P,
  registry: PermissionRegistry = permissionRegistry,
): { [K in keyof P & string]: `${M}.${K}` } {
  const keys: Record<string, string> = {};
  for (const [name, description] of Object.entries(perms)) {
    const key = `${module}.${name}`;
    registry.register({ key, module, description });
    keys[name] = key;
  }
  return keys as { [K in keyof P & string]: `${M}.${K}` };
}
