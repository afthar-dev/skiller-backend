import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { parsePage } from "../../common/http/pagination";
import { RequirePermission } from "../rbac";
import { AuditService } from "./audit.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiZodQuery, ApiPagination } from "../../common/openapi/zod-schema";

const filterSchema = z.object({
  targetType: z.string().min(1).max(100).optional(),
  targetId: z.string().min(1).max(200).optional(),
  actorId: z.string().min(1).max(200).optional(),
});

@ApiTags("Admin")
@Controller("admin/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission("audit.view")
  @ApiOperation({ summary: "Audit log, newest first" })
  @ApiZodQuery(filterSchema)
  @ApiPagination()
  list(@Query() query: Record<string, unknown>) {
    return this.audit.list(filterSchema.parse(query), parsePage(query));
  }
}
