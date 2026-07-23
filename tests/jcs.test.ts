import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/crypto/jcs";

describe("JCS (RFC 8785)", () => {
  it("sorts object keys by UTF-16 code units", () => {
    expect(canonicalize({ b: 1, a: 2, C: 3 })).toBe('{"C":3,"a":2,"b":1}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops insignificant whitespace", () => {
    expect(canonicalize({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it("orders keys by code unit, not by locale", () => {
    // "" < "\r" (U+000D) < "1" (U+0031) < "ö" (o-umlaut) < "€" (euro sign)
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "1": "One",
      "": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(input)).toBe(
      '{"":"Control","\\r":"Carriage Return","1":"One",' +
        '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign"}',
    );
  });

  it("serializes numbers as ECMAScript does", () => {
    expect(canonicalize({ n: 1e21 })).toBe('{"n":1e+21}');
    expect(canonicalize({ n: 1.5 })).toBe('{"n":1.5}');
    expect(canonicalize({ n: 0 })).toBe('{"n":0}');
  });

  it("refuses values that cannot be canonicalized", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow();
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("is stable across key insertion order", () => {
    const a = canonicalize({ tool: "gmail.send", seq: 4, id: "act_1" });
    const b = canonicalize({ id: "act_1", seq: 4, tool: "gmail.send" });
    expect(a).toBe(b);
  });
});
