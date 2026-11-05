import { Injectable } from "@nestjs/common";
import { Prisma, type Plan, type PlanVersion } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import type { MutationMeta } from "../rbac";
import { fromApi, toApi } from "./money";
import { FREE_PLAN_KEY, withLimitDefaults, type PlanLimits, type PlanLimitsInput } from "./plan-catalog";

export interface PlanVersionView {
  id: string;
  planId: string;
  pricePaise: string;
  currency: "INR";
  interval: "MONTH" | "YEAR";
  commissionBps: number;
  limits: PlanLimits;
  createdAt: string;
}

export interface PlanView {
  id: string;
  key: string;
  name: string;
  audience: "CREATOR" | "ORG";
  isActive: boolean;
  versions: PlanVersionView[];
}

export interface NewVersionInput {
  pricePaise: string;
  interval: "MONTH" | "YEAR";
  commissionBps: number;
  limits: PlanLimitsInput;
}

export const toVersionView = (v: PlanVersion, planKey: string): PlanVersionView => ({
  id: v.id,
  planId: v.planId,
  pricePaise: toApi(v.pricePaise),
  currency: "INR",
  interval: v.interval,
  commissionBps: v.commissionBps,
  limits: withLimitDefaults(planKey, v.limits),
  createdAt: v.createdAt.toISOString(),
});

const toPlanView = (p: Plan & { versions: PlanVersion[] }): PlanView => ({
  id: p.id,
  key: p.key,
  name: p.name,
  audience: p.audience,
  isActive: p.isActive,
  versions: p.versions.map((v) => toVersionView(v, p.key)),
});

/** Newest first; ids are UUIDv7 so id order is creation order within one createdAt tick. */
const NEWEST_FIRST = [{ createdAt: "desc" as const }, { id: "desc" as const }];

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every plan with all its versions (admin). */
  async listAll(): Promise<{ items: PlanView[] }> {
    const plans = await this.prisma.plan.findMany({ orderBy: { createdAt: "asc" }, include: { versions: { orderBy: NEWEST_FIRST } } });
    return { items: plans.map(toPlanView) };
  }

  /** Active plans with only the versions a new customer can buy: the newest per interval. */
  async listPublic(): Promise<{ items: PlanView[] }> {
    const plans = await this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" }, include: { versions: { orderBy: NEWEST_FIRST } } });
    return {
      items: plans.map((p) => {
        const seen = new Set<string>();
        const versions = p.versions.filter((v) => (seen.has(v.interval) ? false : (seen.add(v.interval), true)));
        return toPlanView({ ...p, versions });
      }),
    };
  }

  async createPlan(
    actorId: string,
    input: { key: string; name: string; audience: "CREATOR" | "ORG"; version: NewVersionInput },
    meta: MutationMeta = {},
  ): Promise<PlanView> {
    const price = this.priceFor(input.key, input.version.pricePaise);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const plan = await tx.plan.create({ data: { key: input.key, name: input.name, audience: input.audience } });
        const version = await tx.planVersion.create({ data: this.versionData(plan.id, plan.key, price, input.version) });
        const view = toPlanView({ ...plan, versions: [version] });
        await this.audit.record(tx, { actorId, action: "plan.create", targetType: "plan", targetId: plan.id, before: null, after: view as unknown as Prisma.InputJsonValue, ...meta });
        return view;
      });
      return created;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new AppError("PLAN_KEY_TAKEN", 409, "A plan with this key already exists");
      throw err;
    }
  }

  /** Never edits an existing version: a price, commission or limit change is a new row; subscribers stay on theirs. */
  async createVersion(actorId: string, planId: string, input: NewVersionInput, meta: MutationMeta = {}): Promise<PlanVersionView> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new AppError("PLAN_NOT_FOUND", 404, "Plan not found");
    const price = this.priceFor(plan.key, input.pricePaise);
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.planVersion.create({ data: this.versionData(plan.id, plan.key, price, input) });
      const view = toVersionView(version, plan.key);
      await this.audit.record(tx, {
        actorId,
        action: "plan.version_create",
        targetType: "plan_version",
        targetId: version.id,
        before: null,
        after: { planKey: plan.key, ...view } as unknown as Prisma.InputJsonValue,
        ...meta,
      });
      return view;
    });
  }

  private priceFor(planKey: string, pricePaise: string): bigint {
    let price: bigint;
    try {
      price = fromApi(pricePaise);
    } catch {
      throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { pricePaise: ["must be a non-negative integer number of paise, as a string"] } });
    }
    if (planKey === FREE_PLAN_KEY ? price !== 0n : price === 0n) {
      throw new AppError("PLAN_PRICE_INVALID", 422, planKey === FREE_PLAN_KEY ? "The Free plan costs nothing" : "A paid plan needs a price above zero");
    }
    return price;
  }

  private versionData(planId: string, planKey: string, price: bigint, v: NewVersionInput): Prisma.PlanVersionUncheckedCreateInput {
    return { planId, pricePaise: price, interval: v.interval, commissionBps: v.commissionBps, limits: withLimitDefaults(planKey, v.limits) as unknown as Prisma.InputJsonObject };
  }
}
