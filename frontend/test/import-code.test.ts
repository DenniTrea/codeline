import { test } from "node:test";
import assert from "node:assert/strict";
import { importedLines, readCodeFile } from "../src/import-code.ts";
test("code import preserves indentation and normalizes line endings, keeping formatting blanks GIVEN", () => {
  const lines = importedLines(
    'for n in nums:\r\n    print(n)\r\n\r\nprint("done")\r\n',
  );
  assert.deepEqual(lines, [
    { codeText: "for n in nums:", isGiven: false },
    { codeText: "    print(n)", isGiven: false },
    { codeText: "", isGiven: true },
    { codeText: 'print("done")', isGiven: false },
  ]);
});
test("file import rejects empty, binary, oversized and excessive-line files", async () => {
  for (const [content, pattern] of [
    ["", "containing code"],
    ["\0binary", "plain text"],
    ["x".repeat(128001), "128 KB"],
    [Array.from({ length: 501 }, () => "code").join("\n"), "500 lines"],
    ["x".repeat(2001), "2000 characters"],
  ] as const)
    await assert.rejects(
      readCodeFile(new File([content], "code.txt")),
      new RegExp(pattern),
    );
});
test("file import treats markup as inert code text", async () => {
  const code = '<script>alert("not executed")</script>';
  assert.equal(
    (await readCodeFile(new File([code], "code.txt")))[0].codeText,
    code,
  );
});
