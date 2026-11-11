import { Injectable, OnModuleInit } from "@nestjs/common";
import type { MediaAsset } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PlaybackPolicies, type PlaybackAccessPolicy } from "../media";
import { CourseAccessRules } from "./course-access-rules";

/**
 * Who may play a lesson video: whoever may learn the lesson it belongs to (CourseAccessRules.learnAccess). An asset is attached to
 * one lesson at most, so the lesson is found from the asset id. Nothing is cached: every token request re-reads the enrolment, so a
 * refund or a lost seat ends playback with the next request (tokens already issued live out their 10 minutes).
 */
@Injectable()
export class CoursePlaybackPolicy implements PlaybackAccessPolicy, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: CourseAccessRules,
    private readonly policies: PlaybackPolicies,
  ) {}

  onModuleInit() {
    this.policies.register(this);
  }

  /** A signed-out visitor may play the video of a free-preview lesson of a PUBLISHED, unflagged course. */
  async canPlayAnonymously(asset: MediaAsset): Promise<boolean> {
    if (asset.purpose !== "COURSE_LESSON") return false;
    const lessons = await this.prisma.lesson.findMany({ where: { videoAssetId: asset.id }, select: { isFreePreview: true, course: true } });
    return lessons.some((lesson) => this.rules.anonymousLearnAccess(lesson.course, lesson) !== null);
  }

  async canPlay(userId: string, asset: MediaAsset): Promise<boolean> {
    if (asset.purpose !== "COURSE_LESSON") return false;
    const lessons = await this.prisma.lesson.findMany({ where: { videoAssetId: asset.id }, select: { isFreePreview: true, course: true } });
    for (const lesson of lessons) {
      if (await this.rules.learnAccess(userId, lesson.course, lesson)) return true;
    }
    return false;
  }
}
