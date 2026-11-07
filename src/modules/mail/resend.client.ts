export interface ResendMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Passed as Resend's Idempotency-Key so a retried job cannot double-send. */
  idempotencyKey?: string;
}

export interface ResendClient {
  send(msg: ResendMessage): Promise<{ id: string }>;
}

export const RESEND_CLIENT = Symbol("RESEND_CLIENT");

export class ResendApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Resend API error ${status}: ${message}`);
    this.name = "ResendApiError";
  }
}

/** Resend REST client (plain fetch; the official SDK adds nothing we need). */
export class HttpResendClient implements ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly baseUrl = "https://api.resend.com",
    /** The mail queue runs one send at a time: a hung Resend call must end (and be retried, the Idempotency-Key makes that safe) instead of holding every sign-in code behind it. */
    private readonly timeoutMs = 10_000,
  ) {}

  async send(msg: ResendMessage): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new ResendApiError(res.status, (await res.text().catch(() => "")).slice(0, 200));
    const body = (await res.json()) as { id: string };
    return { id: body.id };
  }
}

/** In-memory client for tests. Like Resend, a repeated Idempotency-Key returns the first answer and sends nothing new. */
export class FakeResendClient implements ResendClient {
  readonly sent: ResendMessage[] = [];
  private failStatus: number | null = null;
  private failOnly: Set<string> | null = null;
  private readonly byKey = new Map<string, { id: string }>();
  /** Every call takes this long (a slow Resend). */
  delayMs = 0;
  /** How often Resend was asked at all, repeated Idempotency-Keys and failures included. */
  calls = 0;

  /** All sends fail with `status` (or only those to `onlyTo`); `null` stops failing. */
  failWith(status: number | null, onlyTo?: string[]) {
    this.failStatus = status;
    this.failOnly = onlyTo ? new Set(onlyTo.map((a) => a.toLowerCase())) : null;
  }

  async send(msg: ResendMessage): Promise<{ id: string }> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failStatus !== null && (!this.failOnly || this.failOnly.has(msg.to.toLowerCase()))) throw new ResendApiError(this.failStatus, "fake failure");
    const known = msg.idempotencyKey ? this.byKey.get(msg.idempotencyKey) : undefined;
    if (known) return known;
    this.sent.push(msg);
    const answer = { id: `fake-${this.sent.length}` };
    if (msg.idempotencyKey) this.byKey.set(msg.idempotencyKey, answer);
    return answer;
  }
}
