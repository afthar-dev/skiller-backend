import type { Provider } from "@nestjs/common";
// Load order matters here as in the other modules (billing before courses and rbac: module cycles).
import { BillingMetricsProvider } from "../billing";
import { CoursesMetricsProvider } from "../courses";
import { GigsMetricsProvider } from "../gigs";
import { GrowthMetricsProvider } from "../growth";
import { IdentityMetricsProvider } from "../identity";
import { MessagingMetricsProvider } from "../messaging";
import { ModerationMetricsProvider } from "../moderation";
import { ReelsMetricsProvider } from "../reels";
import { RbacMetricsProvider } from "../rbac";
import { METRICS_PROVIDERS, RollupService } from "./rollup.service";
import { RollupProcessor } from "./rollup.processor";

/** One provider per module, each reading only its own tables. */
export const METRICS_PROVIDER_CLASSES = [
  IdentityMetricsProvider,
  RbacMetricsProvider,
  BillingMetricsProvider,
  CoursesMetricsProvider,
  ReelsMetricsProvider,
  GigsMetricsProvider,
  MessagingMetricsProvider,
  GrowthMetricsProvider,
  ModerationMetricsProvider,
];

/**
 * What both the API and the worker run for the rollup. The providers are small classes that need only the database, exported by the modules that own
 * the data and built here, so the worker does not need those modules' whole graphs (the same shape as growth's segment providers).
 */
export const ANALYTICS_CORE_PROVIDERS: Provider[] = [
  ...METRICS_PROVIDER_CLASSES,
  { provide: METRICS_PROVIDERS, useFactory: (...providers: unknown[]) => providers, inject: METRICS_PROVIDER_CLASSES },
  RollupService,
  RollupProcessor,
];
