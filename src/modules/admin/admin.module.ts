import { Global, Module, forwardRef } from "@nestjs/common";
import { UsersModule } from "../users";
import { AdminController } from "./admin.controller";
import { AdminUsersService } from "./admin-users.service";
import { SettingsModule } from "./settings.module";

/** Admin shell (HTTP). Settings and flags live in the global SettingsModule. */
@Global()
@Module({
  // forwardRef: the users index may still be loading when this file is evaluated (users <-> media <-> admin import each other).
  imports: [forwardRef(() => UsersModule), SettingsModule],
  controllers: [AdminController],
  providers: [AdminUsersService],
})
export class AdminModule {}
