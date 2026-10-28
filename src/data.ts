// Live data for graphics from Google Sheets (shared "anyone with the link") or any CSV URL.
// Same mapping as WebMix Pro: title = columns A,B of the current row; scoreboard = first row
// A team, A score, B team, B score, period; ticker = column A of every row.

export function sheetCsvUrl(url: string): string {
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (!m) return url;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&gid=${gid}`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

export const REFRESH_MS = 10_000;

export async function fetchRows(url: string, header: boolean): Promise<string[][]> {
  const res = await fetch(sheetCsvUrl(url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`โหลดข้อมูลไม่ได้ (HTTP ${res.status}) ตรวจลิงก์และการแชร์ชีต`);
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('ได้หน้าเว็บแทน CSV แชร์ชีตแบบ "ทุกคนที่มีลิงก์ดูได้" แล้วลองอีกครั้ง');
  const rows = parseCsv(text);
  return header ? rows.slice(1) : rows;
}
