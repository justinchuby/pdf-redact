import { describe, expect, it } from "vitest";
import {
  REDACTION_PADDING_POINTS,
  cleanAddressCandidateText,
  escapeHtml,
  isLikelyAddressValue,
  isPlausibleSsnDigits,
  maskCandidateText,
  median,
  padRect,
  parseRegexTerm,
  quadToRect,
  rectKey,
  redactedFileName,
  unionRects,
} from "./redaction";

describe("redactedFileName", () => {
  it("inserts .redacted before the .pdf extension", () => {
    expect(redactedFileName("statement.pdf")).toBe("statement.redacted.pdf");
  });

  it("is case-insensitive about the extension", () => {
    expect(redactedFileName("Form.PDF")).toBe("Form.redacted.pdf");
  });

  it("appends extension when the name has none", () => {
    expect(redactedFileName("scan")).toBe("scan.redacted.pdf");
  });
});

describe("maskCandidateText", () => {
  it("fully masks short strings", () => {
    expect(maskCandidateText("123")).toBe("***");
    expect(maskCandidateText("1234")).toBe("****");
  });

  it("keeps only the last four characters visible", () => {
    expect(maskCandidateText("123456789")).toBe("*****6789");
  });

  it("caps the mask prefix at six characters", () => {
    expect(maskCandidateText("0123456789012345")).toBe("******2345");
  });
});

describe("escapeHtml", () => {
  it("escapes all special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("rectKey", () => {
  it("rounds to one decimal and joins with commas", () => {
    expect(rectKey({ x: 1.04, y: 2.06, width: 3, height: 4.95 })).toBe("1,2.1,3,5");
  });

  it("produces equal keys for rects within rounding tolerance", () => {
    const a = rectKey({ x: 10.01, y: 20.02, width: 5.03, height: 6.04 });
    const b = rectKey({ x: 10.0, y: 20.0, width: 5.0, height: 6.0 });
    expect(a).toBe(b);
  });
});

describe("parseRegexTerm", () => {
  it("parses a /pattern/flags literal and forces the global flag", () => {
    const re = parseRegexTerm("/foo/i");
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.source).toBe("foo");
    expect(re?.flags).toBe("gi");
  });

  it("does not duplicate an existing global flag", () => {
    expect(parseRegexTerm("/bar/g")?.flags).toBe("g");
  });

  it("returns null for non-regex input", () => {
    expect(parseRegexTerm("plain text")).toBeNull();
  });

  it("returns null for an invalid pattern", () => {
    expect(parseRegexTerm("/(/")).toBeNull();
  });
});

describe("median", () => {
  it("returns null for an empty array", () => {
    expect(median([])).toBeNull();
  });

  it("returns the middle value for odd length", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the two middle values for even length", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("unionRects", () => {
  it("returns null for an empty array", () => {
    expect(unionRects([])).toBeNull();
  });

  it("computes the bounding box of multiple rects", () => {
    const result = unionRects([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 5, width: 10, height: 10 },
    ]);
    expect(result).toEqual({ x: 0, y: 0, width: 30, height: 15 });
  });
});

describe("quadToRect", () => {
  it("converts a quad to a padded rect", () => {
    const rect = quadToRect([10, 20, 30, 20, 30, 40, 10, 40]);
    const p = REDACTION_PADDING_POINTS;
    expect(rect).toEqual({
      x: 10 - p,
      y: 20 - p,
      width: 20 + 2 * p,
      height: 20 + 2 * p,
    });
  });
});

describe("isLikelyAddressValue", () => {
  it("accepts a typical street address", () => {
    expect(isLikelyAddressValue("123 Main St")).toBe(true);
  });

  it("rejects values without digits", () => {
    expect(isLikelyAddressValue("Main Street")).toBe(false);
  });

  it("rejects too-short values", () => {
    expect(isLikelyAddressValue("1 a")).toBe(false);
  });

  it("rejects city/state/zip header labels", () => {
    expect(isLikelyAddressValue("City 12345")).toBe(false);
  });

  it("rejects the literal home address label", () => {
    expect(isLikelyAddressValue("home address 1")).toBe(false);
  });
});

describe("cleanAddressCandidateText", () => {
  it("collapses whitespace and trims", () => {
    expect(cleanAddressCandidateText("  123   Main\tSt \n")).toBe("123 Main St");
  });
});

describe("isPlausibleSsnDigits", () => {
  it("accepts a valid 9-digit SSN", () => {
    expect(isPlausibleSsnDigits("123456789")).toBe(true);
  });

  it("rejects invalid area numbers", () => {
    expect(isPlausibleSsnDigits("000456789")).toBe(false);
    expect(isPlausibleSsnDigits("666456789")).toBe(false);
    expect(isPlausibleSsnDigits("900456789")).toBe(false);
  });

  it("rejects a zero group", () => {
    expect(isPlausibleSsnDigits("123006789")).toBe(false);
  });

  it("rejects a zero serial", () => {
    expect(isPlausibleSsnDigits("123450000")).toBe(false);
  });

  it("rejects wrong-length input", () => {
    expect(isPlausibleSsnDigits("12345678")).toBe(false);
  });
});

describe("padRect", () => {
  it("expands a rect symmetrically by the given padding", () => {
    expect(padRect({ x: 10, y: 10, width: 4, height: 6 }, 2, 3)).toEqual({
      x: 8,
      y: 7,
      width: 8,
      height: 12,
    });
  });
});
