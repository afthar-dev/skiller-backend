import pdfParse from "pdf-parse";
import { documentLines, renderInvoicePdf, splitRuns, type DocumentFacts, type InvoiceDetails } from "./invoice-document";

const facts = (over: Partial<DocumentFacts> = {}): DocumentFacts => ({
  docType: "INVOICE",
  kind: "ORDER",
  number: "SKL/26-27/000001",
  issuedAt: "2026-11-03T10:00:00.000Z",
  platform: { legalName: "Skiller Private Limited", address: "1 MG Road, Bengaluru", gstin: "", stateCode: "29", sacCode: "998439" },
  buyer: { name: "Asha Rao", email: "asha@example.com", stateCode: null },
  sellerName: "Ravi Kumar",
  itemTitle: "Intro to Rust",
  listPaise: "100000",
  discountPaise: "0",
  totalPaise: "100000",
  gst: { bps: 1800, basePaise: "8475", taxPaise: "1525", feeTotalPaise: "10000", baseLabel: "Platform fee excluding GST" },
  ...over,
});
const render = (f: DocumentFacts) => renderInvoicePdf({ ...f, lines: documentLines(f) } as InvoiceDetails);

describe("invoice document", () => {
  it("prints legal name, address, GSTIN placeholder, SAC and the place of supply (platform state when the buyer's is unknown)", () => {
    const text = documentLines(facts()).join("\n");
    expect(text).toContain("Skiller Private Limited");
    expect(text).toContain("1 MG Road, Bengaluru");
    expect(text).toContain("GSTIN: applied for");
    expect(text).toContain("SAC: 998439");
    expect(text).toContain("Place of supply: State code 29");
    expect(documentLines(facts({ buyer: { name: "x", email: "y", stateCode: "07" } })).join("\n")).toContain("Place of supply: State code 07");
  });

  it("a credit note says so, references the invoice and prints negative amounts", () => {
    const text = documentLines(facts({ docType: "CREDIT_NOTE", number: "SKC/26-27/000001", original: { number: "SKL/26-27/000001", issuedAt: "2026-11-03T10:00:00.000Z" }, totalPaise: "-100000", gst: { bps: 1800, basePaise: "-8475", taxPaise: "-1525", feeTotalPaise: "-10000", baseLabel: "Platform fee excluding GST" } })).join("\n");
    expect(text).toContain("CREDIT NOTE");
    expect(text).toContain("Against invoice: SKL/26-27/000001 dated 2026-11-03");
    expect(text).toContain("Total refunded: -INR 1000.00");
    expect(text).toContain("-INR 15.25");
  });

  it("splits a line into script runs: Devanagari letters in their own run, spaces and digits stay with the neighbouring run", () => {
    expect(splitRuns("Name: आशा राव 12")).toEqual([
      { text: "Name: ", devanagari: false },
      { text: "आशा राव 12", devanagari: true },
    ]);
    expect(splitRuns("plain")).toEqual([{ text: "plain", devanagari: false }]);
  });

  it("renders Latin text with Noto Sans only", async () => {
    const pdf = await render(facts());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.includes("NotoSans-")).toBe(true);
    expect(pdf.includes("NotoSansDevanagari")).toBe(false);
    expect((await pdfParse(pdf)).text).toContain("Asha Rao");
  });

  it("renders a Hindi buyer name, seller and item title: the Devanagari font is embedded and the text is extractable", async () => {
    const pdf = await render(facts({ buyer: { name: "आशा राव", email: "asha@example.com" }, sellerName: "रवि कुमार", itemTitle: "रस्ट सीखें (Rust)" }));
    expect(pdf.includes("NotoSansDevanagari")).toBe(true);
    const text = (await pdfParse(pdf)).text;
    expect(text).toContain("आशा");
    expect(text).toContain("कुमार");
    expect(text).toContain("Rust");
    expect(text).toContain("asha@example.com");
  });
});
