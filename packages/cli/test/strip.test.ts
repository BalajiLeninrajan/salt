import { describe, expect, test } from "bun:test";
import { strip } from "../src/scan/strip.js";

describe("strip", () => {
  test("keeps plain prose", () => {
    expect(strip("this is a damn mess")).toBe("this is a damn mess");
  });

  test("drops pure injected turns", () => {
    expect(strip("<system-reminder>be nice</system-reminder>")).toBeNull();
    expect(
      strip(
        "<command-message>catppuccin-neu</command-message>\n<command-name>/catppuccin-neu</command-name>",
      ),
    ).toBeNull();
  });

  test("keeps prose around injected blocks", () => {
    const got = strip("fix this <system-reminder>ignore</system-reminder> properly");
    expect(got).toBe("fix this properly");
  });

  test("unwraps nothing from codex delegation", () => {
    const raw = "<codex_delegation>\n  <input>do the thing</input>\n</codex_delegation>";
    expect(strip(raw)).toBeNull();
  });

  test("strips fenced code", () => {
    const raw = "look at this\n```rust\nassert!(x);\nclass Foo;\n```\nit is broken";
    const got = strip(raw)!;
    expect(got).not.toContain("assert");
    expect(got).not.toContain("class");
    expect(got).toContain("broken");
  });

  test("strips unterminated fence", () => {
    expect(strip("why\n```\nassert!(x);")).toBe("why");
  });

  test("strips inline code", () => {
    const got = strip("the `assert_eq!` macro is trash")!;
    expect(got).not.toContain("assert");
    expect(got).toContain("trash");
  });

  test("strips paths", () => {
    const got = strip("check /Users/me/src/assets and ~/.config/hell now")!;
    expect(got).not.toContain("assets");
    expect(got).not.toContain("hell");
    expect(got).toContain("check");
  });

  test("drops codex approval transcript whole", () => {
    const raw =
      "The following is the Codex agent history whose request action you are " +
      "assessing.\n>>> TRANSCRIPT START\n[1] user: this is fucking broken\n";
    expect(strip(raw)).toBeNull();
  });

  test("drops replayed request wrapper", () => {
    expect(strip("## My request for Codex: rebase on master")).toBeNull();
  });

  test("whitespace is Rust's class, not JS \\s", () => {
    // U+FEFF is not a separator: the fused token reads as one path and drops.
    expect(strip("damn\uFEFFa/b/c")).toBeNull();
    expect(strip("foo/x\uFEFFy/bar")).toBeNull();
    // U+0085 NEL is a separator: only the path token drops…
    expect(strip("a\u0085b/c/d")).toBe("a");
    // …and it trims away entirely.
    expect(strip("\u0085")).toBeNull();
  });

  test("path-likeness measures UTF-8 bytes", () => {
    // "/é" is 2 UTF-16 units but 3 bytes, so it is path-like as in v1.
    expect(strip("see /é ok")).toBe("see ok");
  });

  test("tag prefix does not overmatch", () => {
    // `<user_information>` is not `<user_info>`; its text should survive.
    const got = strip("<user_information>keep this</user_information>")!;
    expect(got).toContain("keep this");
  });
});
