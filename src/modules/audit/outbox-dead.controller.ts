import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { OutboxService } from "../../common/outbox/outbox.service";
import { RequirePermission } from "../rbac";

@ApiTags("Admin")
@Controller("admin/outbox")
export class OutboxDeadController {
  constructor(private readonly outbox: OutboxService) {}

  /** Domain events whose handlers failed on every retry: the failed BullMQ job is kept in Redis (queue `outbox`) for replay. */
  @Get("dead")
  @RequirePermission("audit.view")
  @ApiOperation({ summary: "Outbox events that exhausted all delivery attempts, newest first" })
  @ApiPagination()
  dead(@Query() query: Record<string, unknown>) {
    return this.outbox.listDead(parsePage(query));
  }
}
