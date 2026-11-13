import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { DATE_PATTERN, istDayRange } from "../../common/clock/ist";
import { parsePage } from "../../common/http/pagination";
import { ApiPageResult } from "../../common/openapi/money";
import { RequirePermission } from "../rbac";
import { AuditService } from "./audit.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiZodQuery, ApiPagination } from "../../common/openapi/zod-schema";

const isRealDay = (v: string) => {
  try {
    istDayRange(v);
    return true;
  } catch {
    return false;
  }
};
/** An IST calendar day, YYYY-MM-DD. */
const day = z.string().regex(DATE_PATTERN, "a day as YYYY-MM-DD").refine(isRealDay, "not a calendar day");

const filterShape = z.object({
  targetType: z.string().min(1).max(100).optional(),
  targetId: z.string().min(1).max(200).optional(),
  actorId: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(100).optional(),
  from: day.optional(),
  to: day.optional(),
});
const filterSchema = filterShape.refine((v) => !v.from || !v.to || v.from <= v.to, { message: "from must not be after to", path: ["from"] });

@ApiTags("Admin")
@Controller("admin/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission("audit.view")
  @ApiOperation({ summary: "Audit log, newest first. Filter by actor, target, exact action, and an inclusive range of IST days (`from`, `to`, YYYY-MM-DD)" })
  @ApiZodQuery(filterShape)
  @ApiPagination()
  @ApiPageResult("AuditEntry")
  list(@Query() query: Record<string, unknown>) {
    return this.audit.list(filterSchema.parse(query), parsePage(query));
  }
}
