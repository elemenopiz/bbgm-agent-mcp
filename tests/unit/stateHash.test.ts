import { describe, expect, test } from "vitest";

import { stateHash } from "../../src/domain/stateHash.js";

describe("stateHash", () => {
  test("is independent of object key insertion order", () => {
    expect(stateHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stateHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test("changes when a value changes", () => {
    expect(stateHash({ revision: 0, a: 1 })).not.toBe(
      stateHash({ revision: 1, a: 1 }),
    );
  });

  test("is stable across repeated calls with equivalent input", () => {
    const value = { season: 2026, roster: [{ pid: 1, overall: 70 }] };
    expect(stateHash(value)).toBe(stateHash(structuredClone(value)));
  });

  test("produces a 64-character lowercase hex digest", () => {
    expect(stateHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
