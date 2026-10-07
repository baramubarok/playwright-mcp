import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeIdentifier, assertUniqueNormalizedIdentifiers } from "../../src/lib/safeIdentifier.js";

test("accepts safe feature and step identifier formats", () => {
  assert.equal(assertSafeIdentifier("user-profile", "featureName"), "user-profile");
  assert.equal(assertSafeIdentifier("userProfile_2", "steps[0]"), "userProfile_2");
});

test("rejects identifiers that can alter generated paths or source", () => {
  for (const value of ["", " ", "../outside", "foo/bar", "foo\\bar", "foo`bar", "foo\nbar", ".hidden", "-invalid", "123-feature", `a${"b".repeat(64)}`]) {
    assert.throws(() => assertSafeIdentifier(value, "featureName"), /Invalid featureName/);
  }
});

test("detects duplicate generated names after normalization", () => {
  assert.throws(
    () => assertUniqueNormalizedIdentifiers(["paymentStep", "payment-step"], "steps", (value) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()),
    /duplicates another value after normalization/,
  );
});
