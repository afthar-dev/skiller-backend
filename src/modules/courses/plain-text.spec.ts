import { sanitizePlainText } from "./plain-text";

describe("sanitizePlainText", () => {
  it("keeps line breaks, collapses spaces and blank lines", () => {
    expect(sanitizePlainText("  one\r\ntwo \t three\n\n\n\nfour  ", 100)).toBe("one\ntwo three\n\nfour");
  });

  it("removes control, zero-width and bidi characters", () => {
    expect(sanitizePlainText("a\u0000b​c‮d⁦e\u0007f", 100)).toBe("abcdef");
  });

  it("normalises to NFC and cuts at a character boundary", () => {
    expect(sanitizePlainText("é", 10)).toBe("é");
    expect(sanitizePlainText("😀😀😀", 2)).toBe("😀😀");
  });

  it("leaves markup alone (it is escaped on output, not here)", () => {
    expect(sanitizePlainText("<b>hi</b> & [x](y)", 100)).toBe("<b>hi</b> & [x](y)");
  });
});
