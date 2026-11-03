import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "skiller:public";

/** Opts a route (or controller) out of the global AuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
