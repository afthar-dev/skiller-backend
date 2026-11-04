import { Injectable } from "@nestjs/common";
import type { Course, MediaPurpose, Prisma } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { MediaService } from "../media";
import { CoursePolicy } from "./course.policy";

const notUsable = () => new AppError("MEDIA_NOT_USABLE", 422, "This media cannot be used here: it must be a fully processed upload of the right type, owned by the course owner");

/**
 * Attaching media to a course. Ruling: for a USER course the asset must belong to the course owner; for an ORG course it must
 * belong to an author (org_owner / org_instructor) of the owning organization, whichever author uploaded it.
 */
@Injectable()
export class CourseMedia {
  constructor(
    private readonly media: MediaService,
    private readonly policy: CoursePolicy,
  ) {}

  /** Returns the asset's duration (seconds, rounded) so video lessons can copy it. */
  async attach(tx: Prisma.TransactionClient, course: Pick<Course, "ownerType" | "ownerId">, assetId: string, purpose: MediaPurpose): Promise<{ durationSec: number | null }> {
    const info = await this.media.assetInfo(assetId);
    if (!info || info.purpose !== purpose || info.status !== "READY") throw notUsable();
    const ownerOk = course.ownerType === "USER" ? info.ownerId === course.ownerId : await this.policy.isOrgAuthor(info.ownerId, course.ownerId);
    if (!ownerOk) throw notUsable();
    await this.media.attach(tx, assetId, info.ownerId, purpose);
    return { durationSec: info.durationSec === null ? null : Math.round(info.durationSec) };
  }

  detach(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
    return this.media.detach(tx, assetId);
  }
}
