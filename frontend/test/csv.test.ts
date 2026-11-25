import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCsv } from "../src/csv.ts";
test("CSV preserves Unicode, numeric penalties and escaped quoted names", () => {
  assert.equal(
    encodeCsv([['นาม, "Student"', -10, null]]),
    '\ufeff"นาม, ""Student""","-10",""',
  );
});
test("untrusted spreadsheet formulas become inert text", () => {
  const text = encodeCsv([["=1+1", " \t@SUM(1)", "-Student", "+CMD"]]);
  assert.ok(text.includes('"\'=1+1"'));
  assert.ok(text.includes('"\' \t@SUM(1)"'));
  assert.ok(text.includes('"\'-Student"'));
  assert.ok(text.includes('"\'+CMD"'));
});
