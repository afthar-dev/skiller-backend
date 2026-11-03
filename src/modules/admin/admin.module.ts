import { Global, Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { AdminController } from "./admin.controller";
import { AdminUsersService } from "./admin-users.service";
import { SettingsModule } from "./settings.module";

/** Admin shell (HTTP). Settings and flags live in the global SettingsModule. */
@Global()
@Module({
  imports: [UsersModule, SettingsModule],
  controllers: [AdminController],
  providers: [AdminUsersService],
})
export class AdminModule {}
