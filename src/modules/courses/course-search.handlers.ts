import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { OrganizationDirectory } from "../organizations";
import { ProfilesService } from "../users";
import { refreshOwnerSearch } from "./course-search";

/**
 * Courses carry a copy of their owner's name so search needs no join. When a creator changes their display name or an organization is
 * renamed, the copy and the search documents are rebuilt. The handlers read the CURRENT name instead of trusting the event, so late or
 * repeated deliveries (at-least-once) all end in the same state.
 */
@Injectable()
export class CourseSearchHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly orgs: OrganizationDirectory,
  ) {}

  onModuleInit() {
    this.bus.on("user.profile_updated", async (e) => {
      await refreshOwnerSearch(this.prisma, "USER", e.userId, await this.profiles.displayNameOf(e.userId));
    });
    this.bus.on("org.renamed", async (e) => {
      let name: string;
      try {
        name = await this.orgs.nameOf(e.orgId);
      } catch (err) {
        if ((err as { code?: string }).code === "ORG_NOT_FOUND") return; // gone since: nothing to refresh
        throw err;
      }
      await refreshOwnerSearch(this.prisma, "ORG", e.orgId, name);
    });
  }
}
