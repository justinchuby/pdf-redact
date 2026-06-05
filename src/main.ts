import * as mupdf from "mupdf";
import "./style.css";
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
  maskCandidateText,
  median,
  padRect,
  parseRegexTerm,
  quadToRect,
  rectKey,
  redactedFileName,
  unionRects,
  type Rect,
} from "./redaction";

type PatternDefinition = {
  id: string;
  label: string;
  description: string;
  expression: RegExp;
  group?: number;
  defaultEnabled: boolean;
};

type RedactionCandidate = {
  id: string;
  pageIndex: number;
  label: string;
  text: string;
  rects: Rect[];
  selected: boolean;
};

type TextChar = {
  c: string;
  rect: Rect;
};

type TextLine = {
  text: string;
  chars: TextChar[];
};

type PagePreview = {
  pageIndex: number;
  width: number;
  height: number;
  bounds: [number, number, number, number];
  imageUrl: string;
};

type ResidualHit = {
  pageIndex: number;
  text: string;
  rects: Rect[];
};

type AppState = {
  file?: File;
  originalBytes?: Uint8Array;
  candidates: RedactionCandidate[];
  manualCandidates: RedactionCandidate[];
  previews: PagePreview[];
  enabledPatternIds: Set<string>;
  customTerms: string[];
  drawMode: boolean;
  scanDirty: boolean;
  busy: boolean;
};

const RENDER_SCALE = 1.35;

const PATTERNS: PatternDefinition[] = [
  {
    id: "ssn",
    label: "SSN",
    description: "US Social Security numbers such as 123-45-6789",
    expression: SSN_RE,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "form-ssn",
    label: "Form SSN fields",
    description: "Tax form SSNs split into 3-2-4 digit boxes near Social Security Number labels",
    expression:
      /\b(?:(?:your|spouse'?s?)\s+)?(?:ssn|social\s+security\s+number)\b[\s\S]{0,180}?((?:\d[\s-]*){3}[\s-]+(?:\d[\s-]*){2}[\s-]+(?:\d[\s-]*){4})(?![\s-]*\d)/gi,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "masked-ssn",
    label: "Masked SSN",
    description: "Partially-masked SSNs printed on W-2/1099 forms such as XXX-XX-1234 or ***-**-1234",
    expression: MASKED_SSN_RE,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "itin",
    label: "ITIN",
    description: "US ITIN numbers that begin with 9",
    expression: ITIN_RE,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "ein",
    label: "EIN",
    description: "Employer Identification Numbers such as 12-3456789 or 12 3456789",
    expression: EIN_RE,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "tax-label",
    label: "Tax ID labels",
    description:
      "Taxpayer IDs near labels like SSN, TIN, EIN, PAYER'S/RECIPIENT'S TIN, or federal identification number (W-2, 1099, 1098)",
    expression: TAX_LABEL_RE,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "bank-label",
    label: "Bank labels",
    description: "Long digit strings near account, routing, or ABA labels",
    expression: /\b(?:account|acct|routing|aba|bank account)\b[^\n\r\d]{0,32}(\d[\d -]{5,22}\d)/gi,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "home-address",
    label: "Address",
    description: "Address fields on tax forms (1040 home address, W-2/1099 employee, recipient, payer addresses)",
    expression: /\bhome\s+address\b[^\n\r\d]{0,100}(\d[^\n\r]{4,120})/gi,
    group: 1,
    defaultEnabled: true,
  },
  {
    id: "phone",
    label: "Phone",
    description: "US phone numbers such as (555) 123-4567 or 555-123-4567",
    expression: PHONE_RE,
    group: 1,
    defaultEnabled: true,
  },
];

const state: AppState = {
  candidates: [],
  manualCandidates: [],
  previews: [],
  enabledPatternIds: new Set(PATTERNS.filter((pattern) => pattern.defaultEnabled).map((pattern) => pattern.id)),
  customTerms: [],
  drawMode: false,
  scanDirty: false,
  busy: false,
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

const appRoot = app;

render();

function render() {
  appRoot.innerHTML = `
    <main class="shell">
      <section class="topbar">
        <div>
          <p class="eyebrow">Local-only PDF redaction</p>
          <h1>PDF Redactor</h1>
          <p class="subtle">Choose a tax PDF, review detected sensitive fields, then export a truly redacted copy.</p>
        </div>
        <div class="status-pill">${state.file ? escapeHtml(state.file.name) : "No file selected"}</div>
      </section>

      <section class="workspace">
        <aside class="controls">
          <label class="drop-zone" for="pdf-input">
            <input id="pdf-input" type="file" accept="application/pdf,.pdf" />
            <span>Choose or drop PDF</span>
            <small>Everything stays on this computer.</small>
          </label>

          <div class="panel">
            <h2>Patterns</h2>
            <div class="pattern-list">
              ${PATTERNS.map(
                (pattern) => `
                  <label class="check-row" title="${escapeHtml(pattern.description)}">
                    <input type="checkbox" data-pattern="${pattern.id}" ${
                      state.enabledPatternIds.has(pattern.id) ? "checked" : ""
                    } />
                    <span>${escapeHtml(pattern.label)}</span>
                  </label>
                `,
              ).join("")}
            </div>
          </div>

          <div class="panel">
            <h2>Custom terms</h2>
            <div class="inline-form">
              <input id="custom-term" type="text" placeholder="Exact text or /regex/i" />
              <button id="add-term" type="button">Add</button>
            </div>
            <p class="field-help">Use exact text, or regex like <code>/\\bApt\\s+\\d+\\b/i</code>.</p>
            <div class="chips">
              ${state.customTerms
                .map(
                  (term) => `
                    <button class="chip" type="button" data-remove-term="${escapeHtml(term)}">
                      ${escapeHtml(term)} <span aria-hidden="true">x</span>
                    </button>
                  `,
                )
                .join("")}
            </div>
          </div>

          <div class="actions">
            <button id="scan" class="${state.scanDirty ? "attention" : ""}" type="button" ${
              !state.file || state.busy ? "disabled" : ""
            }>${state.scanDirty ? "Scan needed" : "Scan PDF"}</button>
            <button id="save-redacted" class="primary" type="button" ${
              !state.file || selectedCandidates().length === 0 || state.busy ? "disabled" : ""
            }>Download redacted PDF</button>
          </div>
          ${state.scanDirty ? `<p class="scan-note">Detection rules changed. Click Scan to refresh candidates.</p>` : ""}

          <p class="fine-print">
            Scanned-image PDFs need OCR first. This tool redacts text and overlapping image pixels where MuPDF can map a match to page geometry.
          </p>
        </aside>

        <section class="preview">
          <div class="candidate-bar">
            <div>
              <strong>${state.candidates.length}</strong>
              <span>candidate${state.candidates.length === 1 ? "" : "s"} found</span>
            </div>
            <div class="candidate-tools">
              <button id="toggle-draw" class="${state.drawMode ? "active" : ""}" type="button" ${
                state.previews.length === 0 || state.busy ? "disabled" : ""
              }>${state.drawMode ? "Drawing on" : "Draw box"}</button>
              <button id="select-all" type="button" ${state.candidates.length === 0 ? "disabled" : ""}>Select all</button>
              <button id="select-none" type="button" ${state.candidates.length === 0 ? "disabled" : ""}>Select none</button>
            </div>
            ${state.busy ? `<span class="working">Working...</span>` : ""}
          </div>
          ${
            state.drawMode
              ? `<div class="draw-hint">Drag on the PDF page to add a manual redaction box.</div>`
              : ""
          }
          <div class="preview-body">
            <div class="pages-area">
              ${state.previews.length > 0 ? `<h2 class="section-title">Original PDF review</h2>` : ""}
              ${renderPreviews()}
            </div>
            <aside class="candidate-panel">
              ${renderCandidateList()}
            </aside>
          </div>
        </section>
      </section>
    </main>
  `;

  wireEvents();
}

function wireEvents() {
  document.querySelector<HTMLInputElement>("#pdf-input")?.addEventListener("change", async (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files?.[0]) {
      await loadFile(input.files[0]);
    }
  });

  document.querySelector<HTMLLabelElement>(".drop-zone")?.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  document.querySelector<HTMLLabelElement>(".drop-zone")?.addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file?.type === "application/pdf" || file?.name.toLowerCase().endsWith(".pdf")) {
      await loadFile(file);
    }
  });

  document.querySelectorAll<HTMLInputElement>("[data-pattern]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const patternId = checkbox.dataset.pattern;
      if (!patternId) return;
      if (checkbox.checked) {
        state.enabledPatternIds.add(patternId);
      } else {
        state.enabledPatternIds.delete(patternId);
      }
      markScanDirty();
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#add-term")?.addEventListener("click", addCustomTerm);
  document.querySelector<HTMLInputElement>("#custom-term")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      addCustomTerm();
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-term]").forEach((button) => {
    button.addEventListener("click", () => {
      const term = button.dataset.removeTerm;
      state.customTerms = state.customTerms.filter((item) => item !== term);
      markScanDirty();
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#scan")?.addEventListener("click", scanCurrentFile);
  document.querySelector<HTMLButtonElement>("#toggle-draw")?.addEventListener("click", () => {
    state.drawMode = !state.drawMode;
    render();
  });
  document.querySelector<HTMLButtonElement>("#select-all")?.addEventListener("click", () => {
    state.candidates = state.candidates.map((candidate) => ({ ...candidate, selected: true }));
    state.manualCandidates = state.manualCandidates.map((candidate) => ({ ...candidate, selected: true }));
    render();
  });
  document.querySelector<HTMLButtonElement>("#select-none")?.addEventListener("click", () => {
    state.candidates = state.candidates.map((candidate) => ({ ...candidate, selected: false }));
    state.manualCandidates = state.manualCandidates.map((candidate) => ({ ...candidate, selected: false }));
    render();
  });
  document.querySelector<HTMLButtonElement>("#save-redacted")?.addEventListener("click", downloadRedactedPdf);

  document.querySelectorAll<HTMLInputElement>("[data-candidate]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const candidateId = checkbox.dataset.candidate;
      if (!candidateId) return;
      setCandidateSelected(candidateId, checkbox.checked);
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-manual]").forEach((button) => {
    button.addEventListener("click", () => {
      const candidateId = button.dataset.removeManual;
      if (!candidateId) return;
      removeManualCandidate(candidateId);
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-toggle-overlay]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const candidateId = button.dataset.toggleOverlay;
      if (!candidateId) return;
      const candidate = state.candidates.find((item) => item.id === candidateId);
      setCandidateSelected(candidateId, !candidate?.selected);
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-overlay]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const candidateId = button.dataset.removeOverlay;
      if (!candidateId) return;
      removeManualCandidate(candidateId);
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-jump-to]").forEach((row) => {
    const candidateId = row.dataset.jumpTo;
    if (!candidateId) return;

    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("input,button")) return;
      const overlay = document.getElementById(`overlay-${candidateId}-0`);
      if (!overlay) return;
      overlay.scrollIntoView({ behavior: "smooth", block: "center" });
      overlay.classList.add("overlay-highlighted");
      overlay.addEventListener("animationend", () => overlay.classList.remove("overlay-highlighted"), { once: true });
    });

    row.addEventListener("mouseenter", () => {
      document.querySelectorAll<HTMLElement>(`[id^="overlay-${candidateId}-"]`).forEach((el) => {
        el.classList.add("overlay-hover");
      });
    });

    row.addEventListener("mouseleave", () => {
      document.querySelectorAll<HTMLElement>(`[id^="overlay-${candidateId}-"]`).forEach((el) => {
        el.classList.remove("overlay-hover");
      });
    });
  });

  document.querySelectorAll<HTMLElement>("[id^='overlay-']").forEach((overlay) => {
    const match = overlay.id.match(/^overlay-(.+)-\d+$/);
    if (!match) return;
    const candidateId = match[1];

    overlay.addEventListener("mouseenter", () => {
      document.querySelector(`[data-jump-to="${candidateId}"]`)?.classList.add("candidate-row-hover");
    });

    overlay.addEventListener("mouseleave", () => {
      document.querySelector(`[data-jump-to="${candidateId}"]`)?.classList.remove("candidate-row-hover");
    });
  });

  wireManualDrawing();
}

function setCandidateSelected(candidateId: string, selected: boolean) {
  state.candidates = state.candidates.map((candidate) =>
    candidate.id === candidateId ? { ...candidate, selected } : candidate,
  );
  state.manualCandidates = state.manualCandidates.map((candidate) =>
    candidate.id === candidateId ? { ...candidate, selected } : candidate,
  );
}

function removeManualCandidate(candidateId: string) {
  state.manualCandidates = state.manualCandidates.filter((candidate) => candidate.id !== candidateId);
  state.candidates = state.candidates.filter((candidate) => candidate.id !== candidateId);
}

async function loadFile(file: File) {
  revokePreviewUrls();
  state.file = file;
  state.originalBytes = new Uint8Array(await file.arrayBuffer());
  state.candidates = [];
  state.manualCandidates = [];
  state.previews = [];
  state.drawMode = false;
  state.scanDirty = false;
  render();
  await scanCurrentFile();
}

function addCustomTerm() {
  const input = document.querySelector<HTMLInputElement>("#custom-term");
  const term = input?.value.trim();
  if (!term) return;
  if (!state.customTerms.includes(term)) {
    state.customTerms = [...state.customTerms, term];
  }
  if (input) input.value = "";
  markScanDirty();
  render();
}

function markScanDirty() {
  if (state.originalBytes) {
    state.scanDirty = true;
  }
}

function wireManualDrawing() {
  document.querySelectorAll<HTMLElement>(".page-canvas[data-page-index]").forEach((canvas) => {
    canvas.addEventListener("pointerdown", (event) => {
      if (!state.drawMode || state.busy) return;

      const pageIndex = Number(canvas.dataset.pageIndex);
      const preview = state.previews.find((item) => item.pageIndex === pageIndex);
      if (!preview) return;

      event.preventDefault();
      const canvasBox = canvas.getBoundingClientRect();
      const start = pointWithinElement(event, canvasBox);
      const draft = document.createElement("div");
      draft.className = "manual-draft";
      canvas.appendChild(draft);
      canvas.setPointerCapture(event.pointerId);

      const updateDraft = (moveEvent: PointerEvent) => {
        const current = pointWithinElement(moveEvent, canvasBox);
        positionDraft(draft, start, current);
      };

      const cancelDraft = () => {
        canvas.releasePointerCapture(event.pointerId);
        canvas.removeEventListener("pointermove", updateDraft);
        canvas.removeEventListener("pointerup", finishDraft);
        canvas.removeEventListener("pointercancel", cancelDraft);
        draft.remove();
      };

      const finishDraft = (upEvent: PointerEvent) => {
        const end = pointWithinElement(upEvent, canvasBox);
        canvas.releasePointerCapture(upEvent.pointerId);
        canvas.removeEventListener("pointermove", updateDraft);
        canvas.removeEventListener("pointerup", finishDraft);
        canvas.removeEventListener("pointercancel", cancelDraft);
        draft.remove();

        const drawnWidth = Math.abs(end.x - start.x);
        const drawnHeight = Math.abs(end.y - start.y);
        if (drawnWidth < 6 || drawnHeight < 6) return;

        addManualCandidate(pageIndex, manualRectFromPoints(start, end, canvasBox, preview));
      };

      positionDraft(draft, start, start);
      canvas.addEventListener("pointermove", updateDraft);
      canvas.addEventListener("pointerup", finishDraft);
      canvas.addEventListener("pointercancel", cancelDraft);
    });
  });
}

function pointWithinElement(event: PointerEvent, box: DOMRect) {
  return {
    x: Math.min(Math.max(event.clientX - box.left, 0), box.width),
    y: Math.min(Math.max(event.clientY - box.top, 0), box.height),
  };
}

function positionDraft(draft: HTMLElement, start: { x: number; y: number }, end: { x: number; y: number }) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  draft.style.left = `${left}px`;
  draft.style.top = `${top}px`;
  draft.style.width = `${width}px`;
  draft.style.height = `${height}px`;
}

function manualRectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  canvasBox: DOMRect,
  preview: PagePreview,
): Rect {
  const [leftBound, topBound, rightBound, bottomBound] = preview.bounds;
  const leftPercent = Math.min(start.x, end.x) / canvasBox.width;
  const topPercent = Math.min(start.y, end.y) / canvasBox.height;
  const widthPercent = Math.abs(end.x - start.x) / canvasBox.width;
  const heightPercent = Math.abs(end.y - start.y) / canvasBox.height;

  return {
    x: leftBound + leftPercent * (rightBound - leftBound),
    y: topBound + topPercent * (bottomBound - topBound),
    width: widthPercent * (rightBound - leftBound),
    height: heightPercent * (bottomBound - topBound),
  };
}

function addManualCandidate(pageIndex: number, rect: Rect) {
  const candidate: RedactionCandidate = {
    id: `manual-${Date.now()}-${state.manualCandidates.length + 1}`,
    pageIndex,
    label: "Manual box",
    text: "Manual redaction box",
    rects: [rect],
    selected: true,
  };
  state.manualCandidates = [...state.manualCandidates, candidate];
  state.candidates = [...state.candidates, candidate];
  render();
}

async function scanCurrentFile() {
  if (!state.originalBytes) return;

  setBusy(true);
  await nextFrame();

  try {
    revokePreviewUrls();
    const document = openPdfFromOriginal();
    bakeFormFields(document);
    state.candidates = [...scanDocument(document), ...state.manualCandidates];
    state.previews = renderPagePreviews(document);
    patchSearchableResiduals();
    state.scanDirty = false;
  } catch (error) {
    state.candidates = [];
    state.previews = [];
    showError(error);
  } finally {
    setBusy(false);
  }
}

// After scanning, verify by generating the redacted PDF and searching for any
// still-searchable selected value. Merge the leaked glyph positions back into
// the matching candidate so the redaction box visibly grows and the user can
// review the full coverage in the preview before downloading.
function patchSearchableResiduals() {
  for (let pass = 0; pass < 3; pass += 1) {
    const outputBytes = generateRedactedPdf();
    const residuals = findRemainingSearchableTerms(outputBytes);
    if (residuals.length === 0) return;

    for (const hit of residuals) {
      const candidate = state.candidates.find(
        (item) => item.pageIndex === hit.pageIndex && item.text === hit.text && item.selected,
      );
      if (!candidate) continue;
      candidate.rects = [...candidate.rects, ...hit.rects.map((rect) => padRect(rect, 2, 2))];
    }
  }
}

function scanDocument(document: any): RedactionCandidate[] {
  const candidates: RedactionCandidate[] = [];
  const seen = new Set<string>();
  const pageCount = document.countPages();
  const enabledPatterns = PATTERNS.filter((pattern) => state.enabledPatternIds.has(pattern.id));

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.loadPage(pageIndex);
    const text = page.toStructuredText().asText();
    const lines = collectTextLines(page);
    addLineBasedCandidates(pageIndex, lines, candidates, seen);

    const terms = [
      ...findPatternTerms(text, enabledPatterns),
      ...findCustomTerms(text),
    ];

    for (const term of terms) {
      const normalized = term.text.trim();
      if (normalized.length < 2) continue;

      const hits = page.search(normalized, 200);
      for (const hit of hits) {
        const rects = (hit as number[][]).map(quadToRect).filter((rect: Rect) => rect.width > 0 && rect.height > 0);
        if (rects.length === 0) continue;

        addCandidate(candidates, seen, {
          pageIndex,
          label: term.label,
          text: normalized,
          rects,
        });
      }
    }
  }

  return candidates.sort((a, b) => a.pageIndex - b.pageIndex || a.text.localeCompare(b.text));
}

function addCandidate(
  candidates: RedactionCandidate[],
  seen: Set<string>,
  candidate: Omit<RedactionCandidate, "id" | "selected">,
) {
  const rects = candidate.rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return;

  const key = `${candidate.pageIndex}:${candidate.label}:${candidate.text}:${rects.map(rectKey).join("|")}`;
  if (seen.has(key)) return;
  seen.add(key);

  candidates.push({
    ...candidate,
    id: `candidate-${candidates.length + 1}`,
    rects,
    selected: true,
  });
}

function findPatternTerms(text: string, patterns: PatternDefinition[]) {
  const terms: Array<{ label: string; text: string }> = [];

  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.expression.exec(text)) !== null) {
      const term = match[pattern.group ?? 0]?.trim();
      if (term && isPlausiblePatternTerm(pattern, term)) {
        terms.push({ label: pattern.label, text: term });
      }
    }
  }

  return terms;
}

function findCustomTerms(text: string) {
  const terms: Array<{ label: string; text: string }> = [];

  for (const rawTerm of state.customTerms) {
    const parsedRegex = parseRegexTerm(rawTerm);
    if (!parsedRegex) {
      terms.push({ label: "Custom", text: rawTerm });
      continue;
    }

    let match: RegExpExecArray | null;
    parsedRegex.lastIndex = 0;
    while ((match = parsedRegex.exec(text)) !== null) {
      const term = (match[1] ?? match[0]).trim();
      if (term) {
        terms.push({ label: "Custom regex", text: term });
      }
      if (match[0] === "") parsedRegex.lastIndex += 1;
      if (!parsedRegex.global) break;
    }
  }

  return terms;
}

function collectTextLines(page: any): TextLine[] {
  const lines: TextLine[] = [];
  let currentLine: TextLine | null = null;

  page.toStructuredText().walk({
    beginLine() {
      currentLine = { text: "", chars: [] };
    },
    onChar(c: string, _origin: unknown, _font: unknown, _size: unknown, quad: number[]) {
      if (!currentLine) return;
      currentLine.text += c;
      currentLine.chars.push({ c, rect: quadToRect(quad) });
    },
    endLine() {
      if (currentLine && currentLine.text.trim()) {
        lines.push(currentLine);
      }
      currentLine = null;
    },
  });

  return lines;
}

function addLineBasedCandidates(
  pageIndex: number,
  lines: TextLine[],
  candidates: RedactionCandidate[],
  seen: Set<string>,
) {
  if (state.enabledPatternIds.has("form-ssn")) {
    addFormSsnLineCandidates(pageIndex, lines, candidates, seen);
  }

  if (state.enabledPatternIds.has("home-address")) {
    addHomeAddressLineCandidates(pageIndex, lines, candidates, seen);
  }
}

function addFormSsnLineCandidates(
  pageIndex: number,
  lines: TextLine[],
  candidates: RedactionCandidate[],
  seen: Set<string>,
) {
  const labelPattern = /\b(?:your|spouse'?s?)\s+social\s+security\s+number\b/i;

  lines.forEach((line, index) => {
    const labelMatch = line.text.match(labelPattern);
    if (!labelMatch || labelMatch.index === undefined) return;

    const labelEnd = labelMatch.index + labelMatch[0].length;
    const candidateLines = [line, ...lines.slice(index + 1, index + 3)];
    for (const candidateLine of candidateLines) {
      const startIndex = candidateLine === line ? labelEnd : 0;
      const digitIndexes = collectDigitIndexes(candidateLine, startIndex).slice(0, 9);
      const digitChars = digitIndexes.map((digitIndex) => candidateLine.chars[digitIndex]);
      const digits = digitChars.map((char) => char?.c ?? "").join("");
      if (digitIndexes.length !== 9 || !isPlausibleSsnDigits(digits)) continue;

      const firstIndex = digitIndexes[0];
      const lastIndex = digitIndexes[digitIndexes.length - 1];
      const text = candidateLine.chars
        .slice(firstIndex, lastIndex + 1)
        .map((char) => char.c)
        .join("")
        .trim();

      addCandidate(candidates, seen, {
        pageIndex,
        label: "Form SSN area",
        text,
        rects: [estimateFormSsnFieldRect(line, labelMatch.index, labelEnd, digitChars) ?? unionRects(digitChars.map((char) => char.rect))!],
      });
      return;
    }

    const nearbyDigits = findNearbyDigitsForLabel(lines, line, labelMatch.index, labelEnd);
    const digits = nearbyDigits.map((char) => char.c).join("");
    if (nearbyDigits.length === 9 && isPlausibleSsnDigits(digits)) {
      addCandidate(candidates, seen, {
        pageIndex,
        label: "Form SSN area",
        text: nearbyDigits.map((char) => char.c).join(" "),
        rects: [estimateFormSsnFieldRect(line, labelMatch.index, labelEnd, nearbyDigits) ?? unionRects(nearbyDigits.map((char) => char.rect))!],
      });
      return;
    }

    const fallbackRect = estimateFormSsnFieldRect(line, labelMatch.index, labelEnd, nearbyDigits);
    if (fallbackRect) {
      addCandidate(candidates, seen, {
        pageIndex,
        label: "Form SSN area",
        text: "1040 SSN field area",
        rects: [fallbackRect],
      });
    }
  });
}

function estimateFormSsnFieldRect(labelLine: TextLine, labelStart: number, labelEnd: number, nearbyDigits: TextChar[]) {
  const labelRect = unionRects(labelLine.chars.slice(labelStart, labelEnd).map((char) => char.rect));
  if (!labelRect) return null;

  const digitRect = unionRects(nearbyDigits.map((char) => char.rect));
  if (digitRect && nearbyDigits.length >= 3) {
    const sortedDigits = [...nearbyDigits].sort((a, b) => a.rect.x - b.rect.x);
    const digitWidths = sortedDigits.map((char) => char.rect.width).filter((width) => width > 0);
    const medianDigitWidth = median(digitWidths) ?? Math.max(6, digitRect.width / Math.max(nearbyDigits.length, 1));
    const centers = sortedDigits.map((char) => char.rect.x + char.rect.width / 2);
    const gaps = centers
      .slice(1)
      .map((center, index) => center - centers[index])
      .filter((gap) => gap > medianDigitWidth * 0.8);
    const cellPitch = Math.min(Math.max(median(gaps) ?? medianDigitWidth * 1.9, medianDigitWidth * 1.4), medianDigitWidth * 4.5);
    const missingCells = Math.max(0, 9 - nearbyDigits.length);
    const padX = Math.max(10, cellPitch * (missingCells + 1.2));
    const padY = Math.max(5, digitRect.height * 0.45);
    return {
      x: digitRect.x - padX,
      y: digitRect.y - padY,
      width: digitRect.width + padX * 2,
      height: digitRect.height + padY * 2,
    };
  }

  return {
    x: labelRect.x - 10,
    y: labelRect.y - 50,
    width: Math.max(labelRect.width + 180, 240),
    height: Math.max(labelRect.height + 62, 72),
  };
}

function findNearbyDigitsForLabel(lines: TextLine[], labelLine: TextLine, labelStart: number, labelEnd: number) {
  const labelRect = unionRects(labelLine.chars.slice(labelStart, labelEnd).map((char) => char.rect));
  if (!labelRect) return [];

  const candidates = lines
    .flatMap((line) => line.chars)
    .filter((char) => /\d/.test(char.c))
    .filter((char) => {
      const centerX = char.rect.x + char.rect.width / 2;
      const centerY = char.rect.y + char.rect.height / 2;
      return (
        centerX >= labelRect.x - 24 &&
        centerX <= labelRect.x + labelRect.width + 260 &&
        centerY >= labelRect.y - 90 &&
        centerY <= labelRect.y + labelRect.height + 90
      );
    });

  const rows = new Map<number, TextChar[]>();
  for (const candidate of candidates) {
    const rowKey = Math.round((candidate.rect.y + candidate.rect.height / 2) / 6);
    rows.set(rowKey, [...(rows.get(rowKey) ?? []), candidate]);
  }

  const labelCenterY = labelRect.y + labelRect.height / 2;
  const bestRow = [...rows.values()].sort((a, b) => {
    const countDiff = b.length - a.length;
    if (countDiff !== 0) return countDiff;
    const aY = rowCenterY(a);
    const bY = rowCenterY(b);
    return Math.abs(aY - labelCenterY) - Math.abs(bY - labelCenterY);
  })[0];

  return (bestRow ?? []).sort((a, b) => a.rect.x - b.rect.x).slice(0, 9);
}

function rowCenterY(chars: TextChar[]) {
  if (chars.length === 0) return 0;
  return chars.reduce((sum, char) => sum + char.rect.y + char.rect.height / 2, 0) / chars.length;
}

// Collects the name+address block beneath a "name, address, and ZIP code"
// label using geometry (multi-column form headers interleave columns in the
// structured-text stream, so reading order is unreliable). Takes lines whose
// horizontal span sits within the label's left column and whose vertical
// position is just below the label, then keeps the contiguous run until a
// different form field begins.
function collectNameAddressBlock(lines: TextLine[], labelLine: TextLine): TextLine[] {
  const labelRect = lineRect(labelLine);
  if (!labelRect) return [];

  const labelBottom = labelRect.y + labelRect.height;
  const columnRight = labelRect.x + labelRect.width + 30;
  const maxDrop = labelRect.height * 7;

  const below = lines
    .filter((line) => line !== labelLine && line.chars.length > 0)
    .map((line) => ({ line, rect: lineRect(line) }))
    .filter((entry): entry is { line: TextLine; rect: Rect } => entry.rect !== null)
    .filter(({ rect }) => {
      const startsBelow = rect.y >= labelBottom - labelRect.height * 0.4;
      const withinDrop = rect.y <= labelBottom + maxDrop;
      const inColumn = rect.x >= labelRect.x - 12 && rect.x <= columnRight;
      return startsBelow && withinDrop && inColumn;
    })
    .sort((a, b) => a.rect.y - b.rect.y);

  const block: TextLine[] = [];
  let prevBottom: number | null = null;
  for (const { line, rect } of below) {
    if (isBlockBoundaryLine(cleanAddressCandidateText(line.text))) break;
    if (prevBottom !== null) {
      const gap = rect.y - prevBottom;
      if (gap > rect.height * 1.6) break;
    }
    block.push(line);
    prevBottom = rect.y + rect.height;
    if (block.length >= 4) break;
  }
  return block;
}

function addHomeAddressLineCandidates(
  pageIndex: number,
  lines: TextLine[],
  candidates: RedactionCandidate[],
  seen: Set<string>,
) {
  lines.forEach((line, index) => {
    if (!isAddressLabelLine(line.text)) return;

    // W-2 box c / 1099 payer blocks: the label covers NAME + address. Cover the
    // contiguous block of lines directly below the label (employer/payer name,
    // street, city/state/ZIP) until a different form field begins. Select lines
    // by GEOMETRY, not reading order, because multi-column form headers
    // interleave columns in the structured-text stream.
    if (isNameAddressLabel(line.text)) {
      const blockLines = collectNameAddressBlock(lines, line);
      if (blockLines.length > 0) {
        const text = blockLines.map((bl) => cleanAddressCandidateText(bl.text)).join(", ");
        addHomeAddressCandidate(pageIndex, text, blockLines, candidates, seen);
        return;
      }
    }

    const sameLineCandidate = lineAfterLabel(
      line,
      /(?:home|street|mailing)?\s*address(?:\s+and\s+zip(?:\s+code)?)?(?:\s*\([^)]*\))?/i,
    );
    if (sameLineCandidate && isLikelyAddressValue(sameLineCandidate.text)) {
      addHomeAddressCandidate(
        pageIndex,
        sameLineCandidate.text,
        [{ text: sameLineCandidate.text, chars: sameLineCandidate.chars }],
        candidates,
        seen,
      );
    }

    const nearbyOrderedLines = [
      ...lines.slice(Math.max(0, index - 2), index).reverse(),
      ...lines.slice(index + 1, index + 3),
      ...findSpatialAddressLines(lines, line),
    ];

    const valueLines: TextLine[] = [];
    const seenLines = new Set<TextLine>();
    for (const nextLine of nearbyOrderedLines) {
      if (seenLines.has(nextLine)) continue;
      seenLines.add(nextLine);
      const text = cleanAddressCandidateText(nextLine.text);
      if (!isLikelyAddressValue(text)) continue;
      valueLines.push(nextLine);
    }
    if (valueLines.length === 0) return;

    const rows = valueLines.map((valueLine) => {
      const rect = lineRect(valueLine);
      return { y: rect?.y ?? 0, height: rect?.height ?? 0 };
    });

    for (const group of groupAdjacentRows(rows)) {
      const groupLines = group.map((i) => valueLines[i]);
      const text = groupLines.map((groupLine) => cleanAddressCandidateText(groupLine.text)).join(", ");
      addHomeAddressCandidate(pageIndex, text, groupLines, candidates, seen);
    }
  });
}

function addHomeAddressCandidate(
  pageIndex: number,
  text: string,
  blockLines: TextLine[],
  candidates: RedactionCandidate[],
  seen: Set<string>,
) {
  // One tight rect per line instead of a single union box. A union box spans
  // the empty gaps between lines and can overlap neighboring cells, and MuPDF
  // removes ANY glyph that touches a redaction rect (blacking only the rect
  // itself), which would wipe adjacent text. Per-line boxes hug the text.
  const rects = blockLines
    .map((line) => unionRects(line.chars.map((char) => char.rect)))
    .filter((rect): rect is Rect => rect !== null)
    .map((rect) => padRect(rect, 2, 2));
  if (rects.length === 0) return;

  addCandidate(candidates, seen, {
    pageIndex,
    label: "Address",
    text,
    rects,
  });
}

function findSpatialAddressLines(lines: TextLine[], labelLine: TextLine) {
  const labelRect = lineRect(labelLine);
  if (!labelRect) return [];

  return lines
    .filter((line) => line !== labelLine)
    .filter((line) => {
      const rect = lineRect(line);
      if (!rect) return false;
      const centerY = rect.y + rect.height / 2;
      const overlapsX = rect.x + rect.width >= labelRect.x - 12 && rect.x <= labelRect.x + labelRect.width + 60;
      const nearY = centerY >= labelRect.y - 8 && centerY <= labelRect.y + labelRect.height + 60;
      return overlapsX && nearY;
    })
    .sort((a, b) => {
      const aRect = lineRect(a);
      const bRect = lineRect(b);
      if (!aRect || !bRect) return 0;
      const aDistance = Math.abs(aRect.y + aRect.height / 2 - (labelRect.y - 18));
      const bDistance = Math.abs(bRect.y + bRect.height / 2 - (labelRect.y - 18));
      return aDistance - bDistance;
    });
}

function lineRect(line: TextLine) {
  return unionRects(line.chars.map((char) => char.rect));
}

function collectDigitIndexes(line: TextLine, startIndex: number) {
  const indexes: number[] = [];
  for (let index = Math.max(0, startIndex); index < line.chars.length; index += 1) {
    if (/\d/.test(line.chars[index].c)) {
      indexes.push(index);
    }
  }
  return indexes;
}

function lineAfterLabel(line: TextLine, labelPattern: RegExp) {
  const match = line.text.match(labelPattern);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const chars = line.chars.slice(start).filter((char) => char.c.trim());
  const text = chars.map((char) => char.c).join("").trim();
  if (!text) return null;
  return {
    text,
    chars,
    rects: chars.map((char) => char.rect),
  };
}

function isPlausiblePatternTerm(pattern: PatternDefinition, term: string) {
  if (!["ssn", "form-ssn"].includes(pattern.id)) return true;
  const digits = term.replace(/\D/g, "");
  if (digits.length !== 9) return true;
  return isPlausibleSsnDigits(digits);
}

function renderPagePreviews(document: any): PagePreview[] {
  const previews: PagePreview[] = [];
  const pageCount = document.countPages();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.loadPage(pageIndex);
    const bounds = page.getBounds() as [number, number, number, number];
    const pixmap = page.toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
    const pngBytes = toUint8Array(pixmap.asPNG());
    const imageUrl = URL.createObjectURL(new Blob([pngBytes], { type: "image/png" }));
    previews.push({
      pageIndex,
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      bounds,
      imageUrl,
    });
  }

  return previews;
}

async function downloadRedactedPdf() {
  if (!state.originalBytes || !state.file) return;

  setBusy(true);
  await nextFrame();

  try {
    let extraRects: ExtraRect[] = [];
    let outputBytes = generateRedactedPdf();
    let residuals = findRemainingSearchableTerms(outputBytes);

    // Auto-patch: cover any selected value that is still searchable by adding
    // redaction boxes at the leaked glyph positions, then regenerate. Repeats
    // a few times in case a patch reveals adjacent leftovers.
    let passes = 0;
    while (residuals.length > 0 && passes < 3) {
      extraRects = [
        ...extraRects,
        ...residuals.flatMap((hit) =>
          hit.rects.map((rect) => ({ pageIndex: hit.pageIndex, rect: padRect(rect, 2, 2) })),
        ),
      ];
      outputBytes = generateRedactedPdf(extraRects);
      residuals = findRemainingSearchableTerms(outputBytes);
      passes += 1;
    }

    if (residuals.length > 0) {
      const uniqueTerms = [...new Set(residuals.map((hit) => hit.text))];
      const proceed = window.confirm(
        `Warning: these selected values could not be fully removed automatically and may still be searchable:\n\n` +
          `${uniqueTerms.map(maskCandidateText).join(", ")}\n\n` +
          `This usually means the text is an image or could not be located. ` +
          `Use Draw box to cover it manually, or click OK to download anyway.`,
      );
      if (!proceed) return;
    }
    await savePdf(outputBytes, redactedFileName(state.file.name));
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

type ExtraRect = { pageIndex: number; rect: Rect };

function generateRedactedPdf(extraRects: ExtraRect[] = []) {
  const document = openPdfFromOriginal();
  bakeFormFields(document);
  const byPage = new Map<number, Rect[]>();

  for (const candidate of selectedCandidates()) {
    const group = byPage.get(candidate.pageIndex) ?? [];
    group.push(...candidate.rects);
    byPage.set(candidate.pageIndex, group);
  }

  for (const { pageIndex, rect } of extraRects) {
    const group = byPage.get(pageIndex) ?? [];
    group.push(rect);
    byPage.set(pageIndex, group);
  }

  for (const [pageIndex, rects] of byPage.entries()) {
    const page = document.loadPage(pageIndex);
    for (const rect of rects) {
      const annotation = page.createAnnotation("Redact");
      annotation.setRect([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]);
    }
    page.applyRedactions(
      true,
      mupdf.PDFPage.REDACT_IMAGE_PIXELS,
      mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );
  }

  return toUint8Array(document.saveToBuffer("garbage=deduplicate,compress=yes,compress-images=yes"));
}

function bakeFormFields(document: any) {
  if (typeof document.bake === "function") {
    document.bake(false, true);
  }
}

function findRemainingSearchableTerms(pdfBytes: Uint8Array<ArrayBuffer>): ResidualHit[] {
  const document = new mupdf.PDFDocument(pdfBytes.slice());
  const hits: ResidualHit[] = [];

  for (const candidate of selectedCandidates()) {
    if (candidate.label === "Manual box" || candidate.label === "Form SSN area") continue;
    const term = candidate.text.trim();
    if (!term) continue;
    const page = document.loadPage(candidate.pageIndex);
    const matches = page.search(term, 16) as number[][][];
    if (matches.length === 0) continue;

    // Only keep matches that sit at this candidate's OWN location. Searching is
    // page-wide, so the same value (or a header word) may appear elsewhere;
    // blacking those out would delete unrelated text. A match qualifies only if
    // its bounding box overlaps one of the candidate's existing rects.
    const rects: Rect[] = [];
    for (const match of matches) {
      const matchRects = match.map(quadToRect).filter((rect) => rect.width > 0 && rect.height > 0);
      const matchBounds = unionRects(matchRects);
      if (!matchBounds) continue;
      if (!candidate.rects.some((rect) => rectsOverlap(rect, matchBounds))) continue;
      rects.push(...matchRects);
    }

    if (rects.length > 0) {
      hits.push({ pageIndex: candidate.pageIndex, text: term, rects });
    }
  }

  return hits;
}

function rectsOverlap(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function openPdfFromOriginal() {
  if (!state.originalBytes) {
    throw new Error("No PDF loaded");
  }
  return new mupdf.PDFDocument(state.originalBytes.slice());
}

function renderCandidateRow(candidate: RedactionCandidate) {
  return `
    <div class="candidate-row" data-jump-to="${candidate.id}">
      <label class="candidate-check">
        <input type="checkbox" data-candidate="${candidate.id}" ${candidate.selected ? "checked" : ""} />
        <span class="candidate-type">${escapeHtml(candidate.label)}</span>
        <span class="candidate-text">${escapeHtml(maskCandidateText(candidate.text))}</span>
        <span class="candidate-page">p${candidate.pageIndex + 1}</span>
      </label>
      ${
        candidate.label === "Manual box"
          ? `<button class="remove-manual" type="button" data-remove-manual="${candidate.id}">Remove</button>`
          : ""
      }
    </div>
  `;
}

function renderCandidateList() {
  if (!state.file) {
    return `<div class="empty">Choose a PDF to begin.</div>`;
  }
  if (state.candidates.length === 0 && !state.busy) {
    return `<div class="empty">No candidates yet. Try enabling more patterns or adding a custom term.</div>`;
  }

  const PAGE_GROUP = 10;
  const maxPage = Math.max(...state.candidates.map((c) => c.pageIndex));
  const numGroups = Math.ceil((maxPage + 1) / PAGE_GROUP);

  if (numGroups <= 1) {
    return `
      <div class="candidate-list">
        ${state.candidates.map(renderCandidateRow).join("")}
      </div>
    `;
  }

  const groups = Array.from({ length: numGroups }, (_, g) => {
    const start = g * PAGE_GROUP;
    const end = start + PAGE_GROUP - 1;
    const members = state.candidates.filter((c) => c.pageIndex >= start && c.pageIndex <= end);
    return { start, end: Math.min(end, maxPage), members };
  }).filter((g) => g.members.length > 0);

  return `
    <div class="candidate-list">
      ${groups
        .map(
          (group) => `
          <details class="candidate-group" open>
            <summary class="candidate-group-header">
              Pages ${group.start + 1}–${group.end + 1}
              <span class="candidate-group-count">${group.members.length}</span>
            </summary>
            ${group.members.map(renderCandidateRow).join("")}
          </details>
        `,
        )
        .join("")}
    </div>
  `;
}

function renderPreviews() {
  if (state.previews.length === 0) return "";

  return `
    <div class="pages">
      ${state.previews
        .map((preview) => {
          const pageCandidates = state.candidates.filter((candidate) => candidate.pageIndex === preview.pageIndex);
          return `
            <article class="page-card">
              <div class="page-title">Page ${preview.pageIndex + 1}</div>
              <div class="page-canvas ${state.drawMode ? "draw-enabled" : ""}" data-page-index="${preview.pageIndex}" style="width:min(${preview.width}px, 100%); aspect-ratio:${preview.width} / ${preview.height}">
                <img src="${preview.imageUrl}" alt="Page ${preview.pageIndex + 1} preview" />
                ${pageCandidates.flatMap((candidate) => candidate.rects.map((rect, i) => renderOverlay(preview, candidate, rect, i))).join("")}
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderOverlay(preview: PagePreview, candidate: RedactionCandidate, rect: Rect, rectIndex: number) {
  const [leftBound, topBound, rightBound, bottomBound] = preview.bounds;
  const scaleX = preview.width / (rightBound - leftBound);
  const scaleY = preview.height / (bottomBound - topBound);
  const left = ((rect.x - leftBound) * scaleX * 100) / preview.width;
  const top = ((rect.y - topBound) * scaleY * 100) / preview.height;
  const width = (rect.width * scaleX * 100) / preview.width;
  const height = (rect.height * scaleY * 100) / preview.height;

  return `
    <div
      id="overlay-${candidate.id}-${rectIndex}"
      class="redaction-overlay ${candidate.selected ? "selected" : "unselected"}"
      title="${escapeHtml(candidate.label)}: ${escapeHtml(maskCandidateText(candidate.text))}"
      style="left:${left}%; top:${top}%; width:${width}%; height:${height}%"
    >
      <div class="overlay-tooltip">
        <span>${escapeHtml(candidate.label)}</span>
        <button type="button" data-toggle-overlay="${candidate.id}">${candidate.selected ? "Exclude" : "Include"}</button>
        ${
          candidate.label === "Manual box"
            ? `<button type="button" data-remove-overlay="${candidate.id}">Remove</button>`
            : ""
        }
      </div>
    </div>
  `;
}

function selectedCandidates() {
  return state.candidates.filter((candidate) => candidate.selected);
}

async function savePdf(bytes: Uint8Array<ArrayBuffer>, suggestedName: string) {
  const blob = new Blob([bytes], { type: "application/pdf" });

  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  URL.revokeObjectURL(url);
}

function setBusy(busy: boolean) {
  state.busy = busy;
  render();
}

function revokePreviewUrls() {
  for (const preview of state.previews) {
    URL.revokeObjectURL(preview.imageUrl);
  }
}

function toUint8Array(buffer: unknown): Uint8Array<ArrayBuffer> {
  if (buffer instanceof Uint8Array) return copyBytes(buffer);
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (typeof buffer === "object" && buffer && "asUint8Array" in buffer) {
    return copyBytes((buffer as { asUint8Array: () => Uint8Array<ArrayBufferLike> }).asUint8Array());
  }
  return copyBytes(new Uint8Array(buffer as ArrayBufferLike));
}

function copyBytes(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  window.alert(`PDF redaction failed: ${message}`);
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
