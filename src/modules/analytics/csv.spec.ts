import { csvText } from "./analytics.service";

describe("csvText", () => {
  it("prefixes anything a spreadsheet would run as a formula", () => {
    for (const v of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(csvText(v).replace(/^"/, "")).toMatch(/^'/);
  });
  it("quotes commas, quotes and line breaks and leaves plain text alone", () => {
    expect(csvText("plain")).toBe("plain");
    expect(csvText('a,"b"')).toBe('"a,""b"""');
    expect(csvText("a\nb")).toBe('"a\nb"');
    expect(csvText("=a,b")).toBe('"\'=a,b"');
  });
});
