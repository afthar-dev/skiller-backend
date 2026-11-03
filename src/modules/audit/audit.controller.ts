import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { parsePage } from "../../common/http/pagination";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AuditService } from "./audit.service";

const filterSchema = z.object({
  targetType: z.string().min(1).max(100).optional(),
  targetId: z.string().min(1).max(200).optional(),
  actorId: z.string().min(1).max(200).optional(),
});

@Controller("admin/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission("audit.view")
  list(@Query() query: Record<string, unknown>) {
    return this.audit.list(filterSchema.parse(query), parsePage(query));
  }
}
