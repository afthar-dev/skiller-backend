import pino from "pino";
import { Writable } from "node:stream";
import { buildLoggerParams, REDACT_PATHS } from "./logger";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe("logger redaction", () => {
  it("removes credentials and one-time secrets from a log line", () => {
    const { lines, stream } = capture();
    const params = buildLoggerParams({ nodeEnv: "production" });
    const logger = pino({ ...(params.pinoHttp as pino.LoggerOptions), transport: undefined }, stream);

    logger.info({
      req: { id: "r1", headers: { authorization: "Bearer abc", cookie: "skiller_rt=secret", "user-agent": "jest" } },
      res: { headers: { "set-cookie": ["skiller_rt=secret2"], "content-type": "application/json" } },
      body: { code: "123456", token: "tok", refreshToken: "rt", password: "hunter2", email: "a@b.test" },
    });

    const line = lines.join("");
    for (const secret of ["Bearer abc", "skiller_rt=secret", "skiller_rt=secret2", "123456", "tok\"", "rt\"", "hunter2"]) {
      expect(line).not.toContain(secret);
    }
    const parsed = JSON.parse(line);
    expect(parsed.req.headers.authorization).toBe("[Redacted]");
    expect(parsed.req.headers.cookie).toBe("[Redacted]");
    expect(parsed.res.headers["set-cookie"]).toBe("[Redacted]");
    expect(parsed.body).toMatchObject({ code: "[Redacted]", token: "[Redacted]", refreshToken: "[Redacted]", password: "[Redacted]", email: "a@b.test" });
    expect(parsed.req.headers["user-agent"]).toBe("jest");
  });

  it("lists the agreed redact paths", () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining(["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]', "*.code", "*.token", "*.refreshToken", "*.password"]),
    );
  });

  it("uses JSON in production, pretty output in development, silent in tests", () => {
    expect((buildLoggerParams({ nodeEnv: "production" }).pinoHttp as { transport?: unknown }).transport).toBeUndefined();
    expect((buildLoggerParams({ nodeEnv: "development" }).pinoHttp as { transport?: { target: string } }).transport?.target).toBe("pino-pretty");
    expect((buildLoggerParams({ nodeEnv: "test" }).pinoHttp as { level: string }).level).toBe("silent");
  });

  it("binds the request id as requestId", () => {
    const params = buildLoggerParams({ nodeEnv: "production" });
    const props = (params.pinoHttp as { customProps: (req: unknown) => object }).customProps({ id: "req-9" });
    expect(props).toEqual({ requestId: "req-9" });
  });
});
