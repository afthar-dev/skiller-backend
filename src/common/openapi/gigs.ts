/**
 * Response shapes of the gig, studio gig, profile gigs and messaging routes. Each one is what the handler really returns (gig-view.ts, message-view.ts,
 * GigsPublicService, GigCatalogService, MessagingService); the e2e specs check live responses against them. `buildOpenApiDocument` merges `gigComponents`
 * into `components.schemas`; routes name them with `ApiResult` / `ApiPageResult`.
 */
import { MONEY_PATTERN } from "./money";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: "string" } as const;
const nullableStr = { type: "string", nullable: true } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const date = { type: "string", format: "date-time" } as const;
const nullableDate = { type: "string", format: "date-time", nullable: true } as const;
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", required, properties });
const paymentNotice = { ...str, description: "Payments happen outside Skiller and are not protected. Show it as given next to the packages and on the inquiry screen." };

export const gigComponents: Record<string, unknown> = {
  GigPackage: obj({
    tier: { type: "string", enum: ["BASIC", "STANDARD", "PREMIUM"] },
    name: str,
    description: str,
    pricePaise: ref("Money"),
    deliveryDays: int,
    revisions: int,
    features: { type: "array", items: str },
  }),
  GigFaq: obj({ question: str, answer: str }),
  GigSeller: obj({ id: str, handle: str, displayName: str, headline: nullableStr, avatarAssetId: nullableStr, avatarUrl: nullableStr }),
  Gig: obj({
    id: str,
    sellerId: str,
    slug: str,
    title: str,
    description: str,
    categoryId: str,
    tags: { type: "array", items: str },
    status: { type: "string", enum: ["DRAFT", "ACTIVE", "PAUSED", "HIDDEN", "REMOVED"], description: "The seller's view of a gig in any state; deleted gigs are never returned." },
    coverAssetId: nullableStr,
    galleryAssetIds: { type: "array", items: str },
    packages: { type: "array", items: ref("GigPackage"), description: "Ordered BASIC, STANDARD, PREMIUM." },
    faqs: { type: "array", items: ref("GigFaq") },
    createdAt: date,
    updatedAt: date,
    publishedAt: nullableDate,
    paymentNotice,
  }),
  PublicGig: obj({
    id: str,
    slug: str,
    title: str,
    description: str,
    categoryId: str,
    tags: { type: "array", items: str },
    coverAssetId: nullableStr,
    coverUrl: { ...nullableStr, description: "Public URL of the cover (1024 px wide rendition); null when there is no cover or it is not ready." },
    galleryAssetIds: { type: "array", items: str },
    galleryUrls: { type: "array", items: str, description: "Public URLs of the gallery pictures that are ready, in gallery order." },
    packages: { type: "array", items: ref("GigPackage"), description: "Ordered BASIC, STANDARD, PREMIUM." },
    faqs: { type: "array", items: ref("GigFaq") },
    seller: { allOf: [ref("GigSeller")], nullable: true },
    publishedAt: nullableDate,
    paymentNotice,
  }),
  GigCard: obj({
    id: str,
    slug: str,
    title: str,
    categoryId: str,
    tags: { type: "array", items: str },
    coverAssetId: nullableStr,
    coverUrl: { ...nullableStr, description: "Public URL of the cover (1024 px wide rendition); null when there is no cover or it is not ready." },
    startingPricePaise: { type: "string", pattern: MONEY_PATTERN, nullable: true, description: "Money: integer paise as a string. The lowest package price; null when the gig has no package." },
    sellerId: str,
    seller: { allOf: [ref("GigSeller")], nullable: true },
    publishedAt: nullableDate,
  }),
  Message: obj(
    {
      id: str,
      conversationId: str,
      senderId: str,
      body: { ...nullableStr, description: "Plain text. Null while the message is hidden or removed: it keeps its place in the thread without its words, for both sides." },
      status: { type: "string", enum: ["VISIBLE", "HIDDEN", "REMOVED"] },
      createdAt: date,
    },
  ),
  ConversationGig: obj({ id: str, slug: str, title: str }),
  Conversation: obj({
    id: str,
    gigId: nullableStr,
    gig: { allOf: [ref("ConversationGig")], nullable: true, description: "The gig the conversation is about while it is live and its seller may be seen by the viewer; otherwise null." },
    paymentNotice: { ...nullableStr, description: "Set for gig conversations: Skiller does not take part in the deal." },
    lastMessageAt: date,
    unreadCount: int,
    archived: bool,
    counterpart: { allOf: [ref("GigSeller")], nullable: true },
    lastMessage: { allOf: [ref("Message")], nullable: true },
  }),
  ConversationStarted: obj({ conversation: ref("Conversation"), message: ref("Message") }),
  ConversationRead: obj({ conversationId: str, unreadCount: { ...int, description: "Always 0 after this call." } }),
  MessageStreamEvent: obj({ conversationId: str, message: ref("Message") }),
};

/** The body of a `GET /conversations/stream` response: documented, not validated (it is a stream, not JSON). */
export const messageStreamDescription = [
  "Server-sent events (`text/event-stream`). Read it with fetch and the `Authorization: Bearer` header; the browser EventSource cannot send it.",
  "Events: `message` (data: `MessageStreamEvent`, for both participants of a conversation, the sender's other devices too), `expired` (the access token ended) and `revoked` (the session was signed out or revoked); both end the stream with data `{}`, then reconnect with a fresh token.",
  "A comment line (`: ping`) is sent every 25 seconds to keep the stream alive. At most 5 streams per user: opening another closes the oldest.",
].join(" ");
