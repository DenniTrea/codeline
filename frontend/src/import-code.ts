export type CodeLine = { codeText: string; isGiven: boolean };
export function importedLines(text: string): CodeLine[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((codeText) => ({ codeText, isGiven: !codeText.trim() }));
}
export async function readCodeFile(file: File) {
  if (file.size > 128000)
    throw new Error("Choose a text/code file smaller than 128 KB.");
  const text = await file.text();
  if (!text.trim()) throw new Error("Choose a file containing code.");
  if (text.includes("\u0000"))
    throw new Error("Choose a plain text/code file.");
  const lines = importedLines(text);
  if (lines.length > 500 || lines.some((l) => l.codeText.length > 2000))
    throw new Error("Maximum 500 lines, 2000 characters per line.");
  return lines;
}
