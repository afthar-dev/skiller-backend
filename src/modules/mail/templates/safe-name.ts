const MAX_NAME_LENGTH = 60;

/**
 * Names that other users choose (an organization, an inviter's display name) go into mail sent from our domain, so they must not
 * carry a link or an address that makes the mail read as a message from us. Strips URLs, bare domains and email addresses,
 * control characters and angle brackets, collapses whitespace and caps the length.
 */
export function mailSafeName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}<>]/gu, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
    .replace(/\S+@\S+/g, " ")
    .replace(/\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?/gi, (m) => (/^(?:[a-z]{1,3})\.$/i.test(m) ? m : " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned || fallback;
}
