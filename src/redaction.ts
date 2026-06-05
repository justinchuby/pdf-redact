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
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  if (normalized.length < 5) return false;
  if (!/\d/.test(normalized)) return false;
  if (!/[a-z]/i.test(normalized)) return false;
  if (/\baddress\b/.test(lower)) return false;
  if (/\b(?:city|town|state|zip|foreign|presidential|campaign|instructions?)\b/.test(lower)) return false;
  // Reject money / wage / identifier rows that happen to mix digits and letters.
  if (/[$]/.test(normalized)) return false;
  if (
    /\b(?:wages?|tax(?:able)?|compensation|tips?|income|amount|total|withheld|withholding|ein|ssn|i?tin|account|routing|medicare|benefits?|deferrals?|plan)\b/.test(
      lower,
    )
  ) {
    return false;
  }

  // A street line: starts with a house number and contains a street-type word.
  const startsWithNumber = /^\d{1,6}\b/.test(normalized);
  const hasStreetWord =
    /\b(?:street|avenue|boulevard|drive|lane|road|court|circle|place|terrace|highway|parkway|suite|apartment|apt|unit|ste|st|ave|blvd|dr|ln|rd|ct|cir|pl|hwy|pkwy|ter)\b/.test(
      lower,
    );
  const hasPoBox = /\bp\.?\s*o\.?\s*box\s+\d+/i.test(normalized);
  // A city/state/ZIP line: a two-letter state followed by a ZIP, or a
  // "City, ... 12345" shape.
  const hasStateZip = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(normalized);
  const hasCommaZip = /,\s*[A-Za-z .]+\s+\d{5}(?:-\d{4})?\b/.test(normalized);

  return (startsWithNumber && hasStreetWord) || hasPoBox || hasStateZip || hasCommaZip;
}

// True when a line looks like an address *label* on a tax form. Covers the
// 1040 "Home address" plus W-2 / 1099 variants such as "Employee's address",
// "Employer's name, address, and ZIP code", and "RECIPIENT'S address".
export function isAddressLabelLine(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized.includes("address")) return false;
  if (/\b(?:home|street|mailing)\s+address\b/.test(normalized)) return true;
  if (/\baddress\s+and\s+zip\b/.test(normalized)) return true;
  if (
    /\b(?:employee|employer|recipient|payer|spouse|borrower|lender|filer|student)'?s?\b[^.]{0,40}\baddress\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

export function cleanAddressCandidateText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

// True when an address label also covers a party's NAME (e.g. W-2 box c
// "Employer's name, address, and ZIP code" or 1099 "PAYER'S name, street
// address, city..."). For these the name line(s) directly under the label are
// PII too and should be covered together with the address block.
export function isNameAddressLabel(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized.includes("address")) return false;
  return /\bname\b[^.]{0,60}\baddress\b/.test(normalized);
}

// True when a line clearly belongs to a different form field and should stop a
// name+address block (e.g. a box number/label or a money/identifier row).
export function isBlockBoundaryLine(text: string) {
  const normalized = text.trim();
  if (normalized.length === 0) return true;
  const lower = normalized.toLowerCase();
  if (/[$]/.test(normalized)) return true;
  if (
    /\b(?:wages?|tax(?:able)?|compensation|tips?|income|withheld|withholding|ein|ssn|i?tin|control\s+number|employee'?s?\b|social\s+security|medicare|state\s+income|federal\s+income|box\s+\d+)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

// Groups rows (lines) that sit on vertically-adjacent baselines so a
// multi-line address block can be merged into a single redaction box.
// Returns groups of the ORIGINAL indexes, each group sorted top-to-bottom.
// Two rows are adjacent when the vertical gap between them is no larger than
// maxGapFactor times the typical row height.
export function groupAdjacentRows(
  rows: { y: number; height: number }[],
  maxGapFactor = 1.4,
): number[][] {
  const order = rows.map((_, index) => index).sort((a, b) => rows[a].y - rows[b].y);

  const groups: number[][] = [];
  let current: number[] = [];

  for (const index of order) {
    const row = rows[index];
    if (current.length === 0) {
      current = [index];
      continue;
    }

    const prev = rows[current[current.length - 1]];
    const gap = row.y - (prev.y + prev.height);
    const reference = Math.max(prev.height, row.height, 1);

    if (gap <= reference * maxGapFactor) {
      current.push(index);
    } else {
      groups.push(current);
      current = [index];
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

export function isPlausibleSsnDigits(digits: string) {
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  return digits.length === 9 && area !== "000" && area !== "666" && !area.startsWith("9") && group !== "00" && serial !== "0000";
}

// True when the text is a standard inline SSN (3-2-4 groups separated by at
// most a single hyphen or space), i.e. the form the regular SSN pattern
// already matches precisely. Used to avoid adding a redundant, larger
// "Form SSN area" box on top of an already-detected hyphenated SSN.
export function isStandardSsnText(text: string) {
  return /^\d{3}[- ]?\d{2}[- ]?\d{4}$/.test(text.trim());
}

export function padRect(rect: Rect, padX: number, padY: number) {
  return {
    x: rect.x - padX,
    y: rect.y - padY,
    width: rect.width + padX * 2,
    height: rect.height + padY * 2,
  };
}

// --- Detection patterns (exported for unit testing) ---

// US Social Security numbers such as 123-45-6789.
export const SSN_RE = /(?:^|[^\d])((?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4})(?!\d)/g;

// Partially-masked SSNs as printed on many W-2s and 1099s, where the first
// five digits are replaced with X or * but the last four remain, e.g.
// XXX-XX-1234, ***-**-1234, or XXXXX1234.
export const MASKED_SSN_RE =
  /(?:^|[^\w])((?:[X*]{3}[- ]?[X*]{2}[- ]?\d{4})|(?:[X*]{5}\d{4}))(?![\w])/gi;

// US ITIN numbers that begin with 9.
export const ITIN_RE = /(?:^|[^\d])(9\d{2}[- ]?(?:7\d|8[0-8]|9[0-2]|9[4-9])[- ]?\d{4})(?!\d)/g;

// Employer Identification Numbers such as 12-3456789 (a separator is required
// so we don't double-flag bare 9-digit SSNs, which the SSN pattern handles).
export const EIN_RE = /(?:^|[^\d])(\d{2}[-\s]\d{7})(?!\d)/g;

// US phone numbers. Requires phone-style punctuation (parentheses or a
// separator between groups) to avoid matching plain digit runs on forms.
export const PHONE_RE =
  /(?:^|[^\d])((?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4})(?!\d)/g;

// 9-digit taxpayer IDs (SSN/EIN/ITIN/TIN) that appear right after an
// identifying label. Covers the label vocabulary used across W-2, the 1099
// series (PAYER'S / RECIPIENT'S TIN, federal identification number), 1098, etc.
export const TAX_LABEL_RE =
  /\b(?:ssn|social\s+security(?:\s+(?:number|no\.?))?|i?tin|taxpayer\s+id(?:entification)?(?:\s+(?:no\.?|number))?|tax\s+id|ein|employer\s+identification\s+(?:number|no\.?)|payer'?s?\s+(?:tin|fed(?:eral)?\.?\s*id(?:entification)?(?:\s+(?:no\.?|number))?)|recipient'?s?\s+(?:tin|id(?:entification)?(?:\s+(?:no\.?|number))?)|federal\s+identification\s+(?:number|no\.?)|fed\.?\s*id\.?\s*(?:no\.?)?)\b[^\d]{0,80}(\d{2,3}[-\s]?\d{2}[-\s]?\d{4,7})(?!\d)/gi;
