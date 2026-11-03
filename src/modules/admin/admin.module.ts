import { Global, Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { AdminController } from "./admin.controller";
import { AdminUsersService } from "./admin-users.service";
import { FlagsService } from "./flags.service";
import { SettingsService } from "./settings.service";

/** Admin shell. Settings and flags are global so any module can read them (`SettingsService.get`, `FlagsService.isEnabled`). */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AdminController],
  providers: [AdminUsersService, SettingsService, FlagsService],
  exports: [SettingsService, FlagsService],
})
export class AdminModule {}
