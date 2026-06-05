import { describe, expect, it } from "vitest";
import {
  EIN_RE,
  ITIN_RE,
  MASKED_SSN_RE,
  PHONE_RE,
  REDACTION_PADDING_POINTS,
  SSN_RE,
  TAX_LABEL_RE,
  cleanAddressCandidateText,
  escapeHtml,
  groupAdjacentRows,
  isAddressLabelLine,
  isBlockBoundaryLine,
  isLikelyAddressValue,
  isNameAddressLabel,
  isPlausibleSsnDigits,
  isStandardSsnText,
  maskCandidateText,
  median,
  padRect,
  parseRegexTerm,
  quadToRect,
  rectKey,
  redactedFileName,
  unionRects,
} from "./redaction";

function matchGroup(re: RegExp, text: string, group = 1): string[] {
  return [...text.matchAll(re)].map((m) => m[group].trim());
}

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

  it("accepts a city/state/ZIP line", () => {
    expect(isLikelyAddressValue("Springfield, IL 62704")).toBe(true);
  });

  it("accepts a state + ZIP line without a comma", () => {
    expect(isLikelyAddressValue("Springfield IL 62704")).toBe(true);
  });

  it("accepts a PO Box", () => {
    expect(isLikelyAddressValue("PO Box 1234")).toBe(true);
  });

  it("accepts a street line with a unit", () => {
    expect(isLikelyAddressValue("456 Oak Avenue Apt 7")).toBe(true);
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

  it("rejects a wage/amount row", () => {
    expect(isLikelyAddressValue("1 Wages, tips 52000.00")).toBe(false);
    expect(isLikelyAddressValue("Taxable income 41250")).toBe(false);
  });

  it("rejects a dollar amount", () => {
    expect(isLikelyAddressValue("$12,345.67")).toBe(false);
  });

  it("rejects an employer name with digits but no street/zip shape", () => {
    expect(isLikelyAddressValue("Acme Corp 2000")).toBe(false);
  });

  it("rejects a bare number-and-word fragment", () => {
    expect(isLikelyAddressValue("Box 12 checked")).toBe(false);
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

describe("isStandardSsnText", () => {
  it("matches a hyphenated SSN", () => {
    expect(isStandardSsnText("123-45-6789")).toBe(true);
  });

  it("matches a space-separated SSN", () => {
    expect(isStandardSsnText("123 45 6789")).toBe(true);
  });

  it("matches a bare 9-digit SSN", () => {
    expect(isStandardSsnText("123456789")).toBe(true);
  });

  it("rejects cell digits with wide spacing", () => {
    expect(isStandardSsnText("1 2 3 4 5 6 7 8 9")).toBe(false);
  });

  it("rejects values with extra characters", () => {
    expect(isStandardSsnText("SSN 123-45-6789")).toBe(false);
    expect(isStandardSsnText("123-45-67890")).toBe(false);
  });
});

describe("EIN_RE", () => {
  it("matches a hyphenated EIN", () => {
    expect(matchGroup(EIN_RE, "Employer ID 12-3456789 here")).toEqual(["12-3456789"]);
  });

  it("matches a space-separated EIN", () => {
    expect(matchGroup(EIN_RE, "EIN 12 3456789")).toEqual(["12 3456789"]);
  });

  it("does not match a bare 9-digit run (handled by SSN)", () => {
    expect(matchGroup(EIN_RE, "123456789")).toEqual([]);
  });

  it("does not match inside a longer number", () => {
    expect(matchGroup(EIN_RE, "1234567890123")).toEqual([]);
  });
});

describe("PHONE_RE", () => {
  it("matches common phone formats", () => {
    expect(matchGroup(PHONE_RE, "Call (555) 123-4567 now")).toEqual(["(555) 123-4567"]);
    expect(matchGroup(PHONE_RE, "tel 555-123-4567")).toEqual(["555-123-4567"]);
    expect(matchGroup(PHONE_RE, "555.123.4567")).toEqual(["555.123.4567"]);
  });

  it("matches a +1 country code prefix", () => {
    expect(matchGroup(PHONE_RE, "+1 555-123-4567")).toEqual(["+1 555-123-4567"]);
  });

  it("does not match a bare 10-digit run", () => {
    expect(matchGroup(PHONE_RE, "5551234567")).toEqual([]);
  });

  it("does not match an SSN", () => {
    expect(matchGroup(PHONE_RE, "123-45-6789")).toEqual([]);
  });
});

describe("TAX_LABEL_RE", () => {
  it("matches W-2 employer identification number", () => {
    expect(matchGroup(TAX_LABEL_RE, "Employer identification number (EIN) 12-3456789", 1)).toEqual([
      "12-3456789",
    ]);
  });

  it("matches 1099 PAYER'S TIN", () => {
    expect(matchGroup(TAX_LABEL_RE, "PAYER'S TIN 12-3456789", 1)).toEqual(["12-3456789"]);
  });

  it("matches 1099 RECIPIENT'S TIN with an SSN", () => {
    expect(matchGroup(TAX_LABEL_RE, "RECIPIENT'S TIN 123-45-6789", 1)).toEqual(["123-45-6789"]);
  });

  it("matches a curly-apostrophe PAYER\u2019S TIN", () => {
    expect(matchGroup(TAX_LABEL_RE, "PAYER\u2019S TIN 12-3456789", 1)).toEqual(["12-3456789"]);
  });

  it("matches federal identification number", () => {
    expect(matchGroup(TAX_LABEL_RE, "Federal identification number 98-7654321", 1)).toEqual([
      "98-7654321",
    ]);
  });

  it("does not match a number with no nearby label", () => {
    expect(matchGroup(TAX_LABEL_RE, "Total wages 12-3456789", 1)).toEqual([]);
  });
});

describe("SSN_RE / ITIN_RE", () => {
  it("SSN_RE matches a standard SSN", () => {
    expect(matchGroup(SSN_RE, "ssn 123-45-6789")).toEqual(["123-45-6789"]);
  });

  it("ITIN_RE matches a 9xx ITIN", () => {
    expect(matchGroup(ITIN_RE, "ITIN 912-78-1234")).toEqual(["912-78-1234"]);
  });
});

describe("MASKED_SSN_RE", () => {
  it("matches an X-masked SSN with hyphens", () => {
    expect(matchGroup(MASKED_SSN_RE, "SSN XXX-XX-1234")).toEqual(["XXX-XX-1234"]);
  });

  it("matches a lowercase x-masked SSN", () => {
    expect(matchGroup(MASKED_SSN_RE, "ssn xxx-xx-6789")).toEqual(["xxx-xx-6789"]);
  });

  it("matches an asterisk-masked SSN", () => {
    expect(matchGroup(MASKED_SSN_RE, "***-**-4321")).toEqual(["***-**-4321"]);
  });

  it("matches a masked SSN without separators", () => {
    expect(matchGroup(MASKED_SSN_RE, "XXXXX1234")).toEqual(["XXXXX1234"]);
  });

  it("does not match a fully numeric SSN", () => {
    expect(matchGroup(MASKED_SSN_RE, "123-45-6789")).toEqual([]);
  });

  it("does not match when there are too few trailing digits", () => {
    expect(matchGroup(MASKED_SSN_RE, "XXX-XX-12")).toEqual([]);
  });
});

describe("isAddressLabelLine", () => {
  it("matches the 1040 home address label", () => {
    expect(isAddressLabelLine("Home address (number and street)")).toBe(true);
  });

  it("matches the W-2 employee address label", () => {
    expect(isAddressLabelLine("Employee's address and ZIP code")).toBe(true);
  });

  it("matches the W-2 employer address label", () => {
    expect(isAddressLabelLine("Employer's name, address, and ZIP code")).toBe(true);
  });

  it("matches the 1099 recipient address label", () => {
    expect(isAddressLabelLine("RECIPIENT'S street address (including apt. no.)")).toBe(true);
  });

  it("matches a curly-apostrophe Employer\u2019s address label", () => {
    expect(isAddressLabelLine("Employer\u2019s name, address, and ZIP code")).toBe(true);
  });

  it("does not match a line without the word address", () => {
    expect(isAddressLabelLine("Wages, tips, other compensation")).toBe(false);
  });

  it("does not match an address value line", () => {
    expect(isAddressLabelLine("123 Main St, Springfield, IL 62704")).toBe(false);
  });
});

describe("isLikelyAddressValue (label rejection)", () => {
  it("rejects lines containing the word address", () => {
    expect(isLikelyAddressValue("Employee's address and ZIP code")).toBe(false);
  });
});

describe("isNameAddressLabel", () => {
  it("matches the W-2 box c employer name+address label", () => {
    expect(isNameAddressLabel("Employer's name, address, and ZIP code")).toBe(true);
  });

  it("matches a 1099 payer name+address label", () => {
    expect(isNameAddressLabel("PAYER'S name, street address, city or town")).toBe(true);
  });

  it("does not match a plain address label", () => {
    expect(isNameAddressLabel("Employee's address and ZIP code")).toBe(false);
  });

  it("does not match a non-address line", () => {
    expect(isNameAddressLabel("Wages, tips, other compensation")).toBe(false);
  });
});

describe("isBlockBoundaryLine", () => {
  it("treats an empty line as a boundary", () => {
    expect(isBlockBoundaryLine("")).toBe(true);
  });

  it("treats a money row as a boundary", () => {
    expect(isBlockBoundaryLine("Wages, tips 52000.00")).toBe(true);
    expect(isBlockBoundaryLine("$1,234.00")).toBe(true);
  });

  it("treats the employee box as a boundary", () => {
    expect(isBlockBoundaryLine("Employee's social security number")).toBe(true);
  });

  it("does not treat an employer name as a boundary", () => {
    expect(isBlockBoundaryLine("ACME CORPORATION")).toBe(false);
  });

  it("does not treat a street line as a boundary", () => {
    expect(isBlockBoundaryLine("123 Industrial Pkwy")).toBe(false);
  });
});

describe("groupAdjacentRows", () => {
  it("groups two vertically-adjacent lines together", () => {
    const rows = [
      { y: 100, height: 10 },
      { y: 112, height: 10 },
    ];
    expect(groupAdjacentRows(rows)).toEqual([[0, 1]]);
  });

  it("splits lines separated by a large vertical gap", () => {
    const rows = [
      { y: 100, height: 10 },
      { y: 300, height: 10 },
    ];
    expect(groupAdjacentRows(rows)).toEqual([[0], [1]]);
  });

  it("returns indexes ordered top-to-bottom regardless of input order", () => {
    const rows = [
      { y: 124, height: 10 },
      { y: 100, height: 10 },
      { y: 112, height: 10 },
    ];
    expect(groupAdjacentRows(rows)).toEqual([[1, 2, 0]]);
  });

  it("handles an empty input", () => {
    expect(groupAdjacentRows([])).toEqual([]);
  });

  it("keeps separate blocks separate", () => {
    const rows = [
      { y: 100, height: 10 },
      { y: 113, height: 10 },
      { y: 400, height: 10 },
      { y: 413, height: 10 },
    ];
    expect(groupAdjacentRows(rows)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
