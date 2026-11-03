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
    });
    if (!res.ok) throw new ResendApiError(res.status, (await res.text().catch(() => "")).slice(0, 200));
    const body = (await res.json()) as { id: string };
    return { id: body.id };
  }
}

/** In-memory client for tests. */
export class FakeResendClient implements ResendClient {
  readonly sent: ResendMessage[] = [];
  private failStatus: number | null = null;

  failWith(status: number | null) {
    this.failStatus = status;
  }

  async send(msg: ResendMessage): Promise<{ id: string }> {
    if (this.failStatus !== null) throw new ResendApiError(this.failStatus, "fake failure");
    this.sent.push(msg);
    return { id: `fake-${this.sent.length}` };
  }
}
