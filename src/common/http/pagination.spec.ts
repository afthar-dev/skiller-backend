import { parsePage, toPage } from "./pagination";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i + 1}` }));

describe("pagination", () => {
  it("defaults limit to 20 and caps it at 100", () => {
    expect(parsePage({}).limit).toBe(20);
    expect(parsePage({ limit: "500" }).limit).toBe(100);
    expect(parsePage({ limit: "0" }).limit).toBe(1);
    expect(parsePage({ limit: "abc" }).limit).toBe(20);
  });

  it("passes the cursor through", () => {
    expect(parsePage({ cursor: "id-9" }).cursor).toBe("id-9");
    expect(parsePage({}).cursor).toBeUndefined();
  });

  it("returns nextCursor when there are more rows than the limit", () => {
    const page = toPage(rows(21), 20);
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe("id-20");
  });

  it("returns null nextCursor on the last page", () => {
    const page = toPage(rows(5), 20);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });
});
