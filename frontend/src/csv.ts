export function encodeCsv(rows: unknown[][]) {
  const escape = (value: unknown) => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^\s*[=+\-@]/.test(text))
      text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return "\ufeff" + rows.map((row) => row.map(escape).join(",")).join("\r\n");
}
