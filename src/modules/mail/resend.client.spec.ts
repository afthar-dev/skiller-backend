import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpResendClient } from "./resend.client";

describe("HttpResendClient", () => {
  let server: Server;
  let baseUrl: string;
  let behaviour: "hang" | "ok" = "hang";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (behaviour === "hang") return; // never answers
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "mail_1" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const message = { to: "a@example.com", subject: "s", html: "<p>x</p>", text: "x" };

  it("gives up on a Resend call that never answers, so the single mail worker is not held", async () => {
    behaviour = "hang";
    const started = Date.now();
    await expect(new HttpResendClient("key", "from@example.com", baseUrl, 200).send(message)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("still sends normally within the timeout", async () => {
    behaviour = "ok";
    await expect(new HttpResendClient("key", "from@example.com", baseUrl, 2000).send(message)).resolves.toEqual({ id: "mail_1" });
  });
});
