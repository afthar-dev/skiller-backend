import { sanitizePlainText, sanitizeSingleLine } from "./plain-text";

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

describe("sanitizeSingleLine", () => {
  it("turns every kind of line break into one space and never leaves a newline", () => {
    expect(sanitizeSingleLine("one\ntwo\r\nthree four\u0085five\n\n\nsix", 100)).toBe("one two three four five six");
  });

  it("drops control, zero-width and bidi characters, collapses spaces, trims and cuts at a character boundary", () => {
    expect(sanitizeSingleLine("  a‮b​c \t d  ", 100)).toBe("abc d");
    expect(sanitizeSingleLine("😀😀😀", 2)).toBe("😀😀");
    expect(sanitizeSingleLine("​​", 10)).toBe("");
  });
});
