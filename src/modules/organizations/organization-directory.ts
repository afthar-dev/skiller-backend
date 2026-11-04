import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";

/**
 * Worker-safe read access to organization facts other modules print on documents and notifications (it needs only the database, like
 * PlatformRoleDirectory). A missing organization is an error, not a made-up name: outbox handlers retry, documents never carry a guess.
 */
@Injectable()
export class OrganizationDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async nameOf(orgId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    if (!org) throw new AppError("ORG_NOT_FOUND", 404, "Organization not found");
    return org.name;
  }
}
