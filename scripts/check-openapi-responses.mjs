// CLI entry for the response-typing check; the logic is in check-openapi-responses-lib.mjs. It always runs (no "am I the main module" test),
// so a symlinked or wrapped invocation cannot skip the check and exit 0.
import { main } from "./check-openapi-responses-lib.mjs";

main();
