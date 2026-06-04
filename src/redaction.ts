export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const REDACTION_PADDING_POINTS = 1.5;

export function redactedFileName(fileName: string) {
  const withoutPdf = fileName.replace(/\.pdf$/i, "");
  return `${withoutPdf}.redacted.pdf`;
}

export function maskCandidateText(text: string) {
  if (text.length <= 4) return "*".repeat(text.length);
  return `${"*".repeat(Math.min(6, text.length - 4))}${text.slice(-4)}`;
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function rectKey(rect: Rect) {
  return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10).join(",");
}

export function parseRegexTerm(value: string) {
  const match = value.match(/^\/(.+)\/([dgimsuvy]*)$/);
  if (!match) return null;

  try {
    const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
    return new RegExp(match[1], flags);
  } catch {
    return null;
  }
}

export function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function unionRects(rects: Rect[]) {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function quadToRect(quad: number[]): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs) - REDACTION_PADDING_POINTS;
  const minY = Math.min(...ys) - REDACTION_PADDING_POINTS;
  const maxX = Math.max(...xs) + REDACTION_PADDING_POINTS;
  const maxY = Math.max(...ys) + REDACTION_PADDING_POINTS;
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function isLikelyAddressValue(text: string) {
  const normalized = text.trim().toLowerCase();
  if (normalized.length < 5) return false;
  if (!/\d/.test(normalized)) return false;
  if (/\b(?:city|town|state|zip|foreign|presidential|campaign|instructions?)\b/.test(normalized)) return false;
  if (normalized.includes("home address")) return false;
  return /[a-z]/i.test(normalized);
}

export function cleanAddressCandidateText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function isPlausibleSsnDigits(digits: string) {
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  return digits.length === 9 && area !== "000" && area !== "666" && !area.startsWith("9") && group !== "00" && serial !== "0000";
}

export function padRect(rect: Rect, padX: number, padY: number) {
  return {
    x: rect.x - padX,
    y: rect.y - padY,
    width: rect.width + padX * 2,
    height: rect.height + padY * 2,
  };
}
