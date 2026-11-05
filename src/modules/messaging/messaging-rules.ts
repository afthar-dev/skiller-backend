import { AppError } from "../../common/errors/app-error";

export const MESSAGE_MAX = 4000;
/** A person may open conversations with this many people they have never written to, per rolling day. */
export const NEW_CONVERSATIONS_PER_DAY = 20;
/** Messages (new conversations included) per person per rolling hour. */
export const MESSAGES_PER_HOUR = 60;
/** A recipient hears about a conversation's new messages at most once per this long. */
export const MESSAGE_NOTIFY_WINDOW_SEC = 5 * 60;
/** Open live streams one person may hold; the oldest is closed when they open another. */
export const MAX_STREAMS_PER_USER = 5;

export const conversationNotFound = () => new AppError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
/**
 * One answer for every reason you may not write to someone (they blocked you, you blocked them, their message setting, their account is not active):
 * the caller learns nothing about which one it was.
 */
export const messagingNotAllowed = () => new AppError("MESSAGING_NOT_ALLOWED", 403, "You cannot message this person");
export const messagingSelf = () => new AppError("MESSAGING_SELF", 422, "You cannot message yourself");

/** The two ids in a fixed order: the unique key of a direct conversation, whoever started it. */
export const pairKeyOf = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export const streamChannel = (userId: string) => `msg:user:${userId}`;
