declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
  interface Env {
    PRIVATE_BUCKET: R2Bucket;
    PLAYBACK_SECRET: string;
    ALLOWED_ORIGINS: string;
  }
}
