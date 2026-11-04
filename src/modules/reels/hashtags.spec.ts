import { extractHashtags } from "./hashtags";

describe("extractHashtags", () => {
  it("finds tags, lower-cases them and drops duplicates in order of appearance", () => {
    expect(extractHashtags("Learning #React and #NodeJS today #react #Node_JS")).toEqual(["react", "nodejs", "node_js"]);
  });

  it("normalises to NFC and keeps non-Latin tags whole, including Indic vowel signs", () => {
    expect(extractHashtags("#Café #भारत #学习2")).toEqual(["café", "भारत", "学习2"]);
  });

  it("ignores a '#' inside a word, a bare '#', an over-long tag and anything after the tenth tag", () => {
    expect(extractHashtags("a#b # #" + "x".repeat(51) + " #ok")).toEqual(["ok"]);
    const many = Array.from({ length: 14 }, (_, i) => `#t${i}`).join(" ");
    expect(extractHashtags(many)).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`));
  });

  it("accepts a tag of exactly 50 characters", () => {
    expect(extractHashtags(`#${"a".repeat(50)}`)).toEqual(["a".repeat(50)]);
  });
});
