import { Injectable } from "@nestjs/common";
import type { Prisma, ReportTargetType } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Whether content has reports waiting for a decision (owners keep such content, and its video, until a moderator has decided). */
@Injectable()
export class OpenReports {
  constructor(private readonly prisma: PrismaService) {}

  async exist(tx: Prisma.TransactionClient | undefined, type: ReportTargetType, id: string): Promise<boolean> {
    return (await (tx ?? this.prisma).report.count({ where: { targetType: type, targetId: id, status: "OPEN" }, take: 1 })) > 0;
  }
}
