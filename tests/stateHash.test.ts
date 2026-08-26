import { describe, expect, test } from "vitest";

import { stateHash } from "../src/domain/stateHash.js";

describe("stateHash", () => {
  test("is independent of object key insertion order", () => {
    expect(stateHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stateHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});

