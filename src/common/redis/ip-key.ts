import { isIP } from "node:net";

/** Expands an IPv6 address to its eight 16-bit groups (hex, unpadded), or null. */
function groupsOf(ip: string): string[] | null {
  const noZone = ip.split("%")[0].toLowerCase();
  let head = noZone;
  let tail = "";
  const gap = noZone.indexOf("::");
  if (gap >= 0) {
    head = noZone.slice(0, gap);
    tail = noZone.slice(gap + 2);
  }
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = gap >= 0 ? 8 - h.length - t.length : 0;
  if (fill < 0 || (gap < 0 && h.length !== 8)) return null;
  const all = [...h, ...Array<string>(fill).fill("0"), ...t];
  return all.length === 8 ? all.map((g) => parseInt(g || "0", 16).toString(16)) : null;
}

/**
 * The key a per-IP limit should count. IPv4 is the address itself; IPv6 is its /64, because one subscriber owns a whole /64 and
 * can rotate through all of it. Use it in every IP-keyed limit.
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const groups = groupsOf(ip);
  return groups ? `v6:${groups.slice(0, 4).join(":")}` : ip;
}
