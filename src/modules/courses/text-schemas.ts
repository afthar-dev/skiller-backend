import { z } from "zod";
import { sanitizeSingleLine } from "./plain-text";

/** A one-line plain-text field (titles, subtitles): sanitised first, then held to min / max of what is left. */
export const singleLine = (min: number, max: number) => z.preprocess((v) => (typeof v === "string" ? sanitizeSingleLine(v, max * 4) : v), z.string().min(min).max(max));
