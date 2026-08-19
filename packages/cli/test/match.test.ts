import { describe, expect, test } from "bun:test";
import { Matcher } from "../src/match.js";

const words = (text: string): string[] => new Matcher().find(text).map((h) => h.word);

describe("match", () => {
  test("finds plain swears", () => {
    expect(words("this is fucking broken")).toEqual(["fucking"]);
    expect(words("what the hell")).toEqual(["hell"]);
  });

  test("is case insensitive", () => {
    expect(words("WHAT THE FUCK")).toEqual(["fuck"]);
  });

  test("handles censoring and leetspeak", () => {
    expect(words("f*ck this")).toEqual(["fuck"]);
    expect(words("sh1t")).toEqual(["shit"]);
    expect(words("this is BULLSH!T")).toEqual(["bullshit"]);
  });

  test("matches inflections", () => {
    expect(words("shitty code")).toEqual(["shit"]);
    expect(words("fucked it up")).toEqual(["fucked"]);
    expect(words("damned thing")).toEqual(["damn"]);
  });

  test("assigns tiers", () => {
    const m = new Matcher();
    expect(m.find("damn")[0].tier).toBe("mild");
    expect(m.find("shit")[0].tier).toBe("medium");
    expect(m.find("fuck")[0].tier).toBe("strong");
    expect(m.find("wtf")[0].tier).toBe("acronym");
  });

  // The Scunthorpe problem. These appear constantly in real prompts and a
  // single false positive here destroys trust in the whole report.
  test("does not match innocent technical words", () => {
    for (const word of [
      "assert",
      "assert_eq",
      "assertion",
      "assign",
      "assignment",
      "asset",
      "assets",
      "class",
      "classes",
      "pass",
      "passed",
      "password",
      "bypass",
      "bass",
      "massive",
      "hello",
      "shell",
      "analysis",
      "cassandra",
      "canvas",
      "assume",
      "access",
      "assistant",
      "async",
      "harassment",
      "scunthorpe",
      "dickinson",
      "sussex",
    ]) {
      expect(words(word)).toEqual([]);
    }
  });

  test("does not match swear inside a larger word", () => {
    expect(words("passthrough")).toEqual([]);
    expect(words("classic")).toEqual([]);
  });

  test("counts every occurrence", () => {
    expect(words("fuck this fucking shit")).toHaveLength(3);
  });

  test("respects removals and allow overrides", () => {
    let m = new Matcher({ add: [], remove: ["hell"], allow: [] });
    expect(m.find("what the hell")).toEqual([]);

    m = new Matcher({ add: [], remove: [], allow: ["damn"] });
    expect(m.find("damn")).toEqual([]);
  });

  test("supports added words", () => {
    const m = new Matcher({ add: [["blast", "mild"]], remove: [], allow: [] });
    expect(m.find("oh blast")[0].tier).toBe("mild");
  });

  test("empty add word matches nothing and never crashes", () => {
    // Deliberate divergence: v1 turned this into an empty Aho-Corasick
    // pattern — zero-width hits everywhere and a panic on non-ASCII text.
    const m = new Matcher({ add: [["", "mild"]], remove: [], allow: [] });
    expect(m.find("s")).toEqual([]);
    expect(m.find("ed ing")).toEqual([]);
    expect(m.find("fuckéfuck")).toHaveLength(2);
  });

  test("finds insults", () => {
    expect(words("you are an idiot")).toEqual(["idiot"]);
    expect(words("stop being a moron")).toEqual(["moron"]);
    expect(words("that was a stupid change")).toEqual(["stupid"]);
    expect(words("this is a dumb approach")).toEqual(["dumb"]);
    expect(words("absolutely retarded")).toEqual(["retarded"]);
    expect(words("stupidly slow")).toEqual(["stupid"]);
  });

  test("insults carry their tier", () => {
    const tier = (t: string) => new Matcher().find(t)[0].tier;
    expect(tier("dumb")).toBe("mild");
    expect(tier("idiot")).toBe("medium");
    expect(tier("retard")).toBe("strong");
  });

  test("insults do not match innocent words", () => {
    for (const t of ["oxymoron", "dumbbell", "dumbbells", "flame retardant", "dumbo"]) {
      expect(new Matcher().find(t)).toEqual([]);
    }
  });
});
