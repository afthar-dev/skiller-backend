import { AppError } from "../../common/errors/app-error";

export const stateInvalid = (message: string) => new AppError("COURSE_STATE_INVALID", 409, message);

/** Who is acting and from where, for the audit trail. */
export interface ActionMeta {
  actorId: string;
  ip?: string;
  requestId?: string;
}
