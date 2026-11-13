import "reflect-metadata";
import { ConversationsController } from "./conversations.controller";

describe("ConversationsController OpenAPI", () => {
  it("documents the `after` query of the message list, which the polling fallback depends on", () => {
    const params = Reflect.getMetadata("swagger/apiParameters", ConversationsController.prototype.messages) as Array<{ name: string; in: string; required?: boolean }>;
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "after", in: "query", required: false })]));
  });

  it("documents the `archived` query of the conversation list", () => {
    const params = Reflect.getMetadata("swagger/apiParameters", ConversationsController.prototype.list) as Array<{ name: string; in: string }>;
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "archived", in: "query" })]));
  });
});
