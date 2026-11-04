import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SellableRegistry, type PaidOrder, type SellableDescription, type SellableProvider } from "../billing";
import { PlatformRoleDirectory } from "../rbac";
import { EnrolmentsService, ORG_LEARNER_ROLE } from "./enrolments.service";
import { ORG_AUTHOR_ROLES } from "./org-roles";

/** Why a course cannot be bought; the specific reasons checkout shows the buyer. */
export const COURSE_NOT_PURCHASABLE = {
  notAvailable: "COURSE_NOT_AVAILABLE",
  alreadyEnrolled: "COURSE_ALREADY_ENROLLED",
  own: "COURSE_OWN",
  free: "COURSE_FREE",
  orgSeat: "COURSE_ORG_SEAT",
} as const;

const courseNotFound = () => new AppError("COURSE_NOT_FOUND", 404, "Course not found");

/**
 * The COURSE item type of Phase 2 checkout. Registered in the API (checkout) and in the worker (webhook-first fulfilment runs
 * there). The item id is the course id. Fulfilment gives the buyer what they paid for even when the course was unpublished,
 * flagged or archived since checkout: they paid the price they were shown for the course they were shown.
 */
@Injectable()
export class CourseSellable implements SellableProvider, OnModuleInit {
  readonly type = "COURSE";

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SellableRegistry,
    private readonly enrolments: EnrolmentsService,
    private readonly roles: PlatformRoleDirectory,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async describe(itemId: string, ctx: { buyerId: string }): Promise<SellableDescription> {
    const course = await this.prisma.course.findUnique({ where: { id: itemId } });
    if (!course) throw courseNotFound();
    const description = { title: course.title, pricePaise: course.pricePaise, sellerOwnerType: course.ownerType, sellerOwnerId: course.ownerId };
    const no = (reason: string): SellableDescription => ({ ...description, purchasable: false, reason });

    let orgRoles: string[] = [];
    if (course.ownerType === "USER") {
      if (course.ownerId === ctx.buyerId) return no(COURSE_NOT_PURCHASABLE.own);
    } else {
      orgRoles = await this.roles.roleKeysInOrg(ctx.buyerId, course.ownerId);
      if (orgRoles.some((r) => (ORG_AUTHOR_ROLES as readonly string[]).includes(r))) return no(COURSE_NOT_PURCHASABLE.own);
    }
    if (await this.enrolments.activeFor(ctx.buyerId, course.id)) return no(COURSE_NOT_PURCHASABLE.alreadyEnrolled);
    if (orgRoles.includes(ORG_LEARNER_ROLE)) return no(COURSE_NOT_PURCHASABLE.orgSeat);
    if (course.status !== "PUBLISHED" || course.flaggedAt) return no(COURSE_NOT_PURCHASABLE.notAvailable);
    if (course.pricePaise === 0n) return no(COURSE_NOT_PURCHASABLE.free);
    return { ...description, purchasable: true };
  }

  /** A missing course is a permanent 4xx: the payment is refunded instead of retried forever. */
  async onPaid(tx: Prisma.TransactionClient, order: PaidOrder): Promise<void> {
    const item = order.items[0];
    const course = await tx.course.findUnique({ where: { id: item.itemId }, select: { id: true } });
    if (!course) throw courseNotFound();
    await this.enrolments.grant(tx, { courseId: course.id, userId: order.buyerId, source: "PURCHASE", orderId: order.id });
  }

  async onRefunded(tx: Prisma.TransactionClient, order: PaidOrder): Promise<void> {
    await this.enrolments.revokeForOrder(tx, { courseId: order.items[0].itemId, userId: order.buyerId, orderId: order.id });
  }
}
