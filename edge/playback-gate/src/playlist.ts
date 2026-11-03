const isAbsolute = (uri: string) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) || uri.startsWith("//");

/** Adds `t=<token>` to a relative URI, keeping its query string (and fragment). Absolute URIs are left alone so the token never leaves this origin. */
export function withToken(uri: string, token: string): string {
  if (uri === "" || isAbsolute(uri)) return uri;
  const hash = uri.indexOf("#");
  const beforeHash = hash === -1 ? uri : uri.slice(0, hash);
  const fragment = hash === -1 ? "" : uri.slice(hash);
  const q = beforeHash.indexOf("?");
  const path = q === -1 ? beforeHash : beforeHash.slice(0, q);
  const kept = q === -1 ? [] : beforeHash.slice(q + 1).split("&").filter((p) => p !== "" && p !== "t" && !p.startsWith("t="));
  return `${path}?${[...kept, `t=${token}`].join("&")}${fragment}`;
}

/** Appends the token to every URI line and every `URI="..."` tag attribute (EXT-X-MAP, EXT-X-KEY, EXT-X-MEDIA, ...). */
export function rewritePlaylist(text: string, token: string): string {
  return text
    .split("\n")
    .map((raw) => {
      const cr = raw.endsWith("\r") ? "\r" : "";
      const line = cr ? raw.slice(0, -1) : raw;
      if (line.trim() === "") return raw;
      if (line.startsWith("#")) return line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${withToken(uri, token)}"`) + cr;
      return withToken(line.trim(), token) + cr;
    })
    .join("\n");
}
