import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { sanitizePlainText } from "../courses";
import { SessionService } from "../identity";
import { MESSAGE_STREAM_OPTIONS, MessageStreamHub, type MessageStreamOptions } from "./message-stream.hub";
import { MessagingService } from "./messaging.service";
import { MESSAGE_MAX } from "./messaging-rules";

/** Plain text, cleaned the same way as other user text, at least one character left and at most MESSAGE_MAX. */
const messageText = z.preprocess((v) => (typeof v === "string" ? sanitizePlainText(v, MESSAGE_MAX * 4) : v), z.string().min(1).max(MESSAGE_MAX));

const startSchema = z.object({ recipientHandle: z.string().trim().min(1).max(60), gigId: z.string().uuid().optional(), message: messageText }).strict();
const sendSchema = z.object({ body: messageText }).strict();

@ApiTags("Messaging")
@AuthenticatedOnly()
@Controller("conversations")
export class ConversationsController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly hub: MessageStreamHub,
    private readonly sessions: SessionService,
    @Inject(MESSAGE_STREAM_OPTIONS) private readonly options: MessageStreamOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @ApiOperation({ summary: "Message a person (get-or-create the conversation of the pair and append the message). 201 when the conversation is new, 200 when it existed. From a gig: send gigId (a live gig of that person). MESSAGING_NOT_ALLOWED never says why (block, the person's setting or their account); 20 new people a day and 60 messages an hour" })
  @ApiZodBody(startSchema)
  async start(@CurrentUser() user: AuthUser, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { created, conversation, message } = await this.messaging.start(user.id, startSchema.parse(body));
    res.status(created ? 201 : 200);
    return { conversation, message };
  }

  @Get()
  @ApiOperation({ summary: "My conversations, most recently active first, with unread counts. `archived=true` lists the archived ones" })
  @ApiPagination()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.messaging.list(user.id, { archived: query.archived === "true" }, parsePage(query));
  }

  @Get("unread-count")
  @ApiOperation({ summary: "How many messages from others I have not read, over all my conversations" })
  unread(@CurrentUser() user: AuthUser) {
    return this.messaging.unreadTotal(user.id);
  }

  @Get("stream")
  @ApiOperation({
    summary:
      "Server-sent events: `message` events for my conversations as they happen (text/event-stream). A comment line every 25 s keeps it alive; the stream ends with an `expired` or `revoked` event when the access token or session ends, then reconnect with a fresh token. Send the Authorization header (fetch-based SSE clients; the browser EventSource cannot). Everything here is also available by polling GET /conversations/:id/messages?after=",
  })
  async stream(@CurrentUser() user: AuthUser, @Req() req: Request, @Res() res: Response): Promise<void> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
    const expiresAtMs = typeof exp === "number" ? exp * 1000 : this.clock.now().getTime();

    let ended = false;
    // Filled in as the stream comes up; end() releases whatever exists by then.
    const held: { tick?: NodeJS.Timeout; expiry?: NodeJS.Timeout; unsubscribe?: () => void; untrack?: () => void } = {};
    const end = (reason?: "expired" | "revoked") => {
      if (ended) return;
      ended = true;
      if (held.tick) clearInterval(held.tick);
      if (held.expiry) clearTimeout(held.expiry);
      held.unsubscribe?.();
      held.untrack?.();
      if (!res.writableEnded && !res.destroyed) {
        if (reason) res.write(`event: ${reason}\ndata: {}\n\n`);
        res.end();
      }
    };
    req.on("close", () => end());

    held.unsubscribe = await this.hub.subscribe(user.id, (payload) => {
      if (ended) return;
      const { event, data } = JSON.parse(payload) as { event: string; data: unknown };
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    if (ended) {
      held.unsubscribe();
      return;
    }
    held.untrack = this.hub.track(user.id, () => end());

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    held.tick = setInterval(() => {
      void (async () => {
        if (ended) return;
        if (this.clock.now().getTime() >= expiresAtMs) return end("expired");
        try {
          if (await this.sessions.isRevoked(user.sessionId)) return end("revoked");
        } catch {
          // Redis hiccup: keep the stream, the next beat checks again
        }
        if (!ended) res.write(": ping\n\n");
      })();
    }, this.options.heartbeatMs);
    held.tick.unref();
    // The beat above checks the token too; this timer makes the end precise (never longer than a timer can hold).
    held.expiry = setTimeout(() => end("expired"), Math.min(Math.max(expiresAtMs - this.clock.now().getTime(), 0), 2 ** 31 - 1));
    held.expiry.unref();
  }

  @Get(":id/messages")
  @ApiOperation({ summary: "Messages of one of my conversations, newest first with a cursor. `after=<message id>` returns the messages since then, oldest first (polling). A hidden or removed message has no text. Anyone else's conversation is a 404" })
  @ApiPagination()
  messages(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: Record<string, unknown>) {
    const after = typeof query.after === "string" && query.after.length > 0 ? query.after : undefined;
    return this.messaging.messages(user.id, id, parsePage(query), after);
  }

  @Post(":id/messages")
  @ApiOperation({ summary: "Send a plain-text message (at most 4000 characters) in one of my conversations. 60 messages an hour" })
  @ApiZodBody(sendSchema)
  send(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.messaging.send(user.id, id, sendSchema.parse(body).body);
  }

  @Post(":id/read")
  @HttpCode(200)
  @ApiOperation({ summary: "Mark everything in the conversation read" })
  read(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.messaging.markRead(user.id, id);
  }

  @Post(":id/archive")
  @HttpCode(204)
  @ApiOperation({ summary: "Move the conversation out of my inbox (a new message brings it back)" })
  async archive(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.messaging.setArchived(user.id, id, true);
  }

  @Post(":id/unarchive")
  @HttpCode(204)
  @ApiOperation({ summary: "Bring an archived conversation back" })
  async unarchive(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.messaging.setArchived(user.id, id, false);
  }
}
