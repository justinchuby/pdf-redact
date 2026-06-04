# Local PDF Redactor

A local-only PDF redaction web app for SSN, EIN, ITIN, and other tax-document identifiers.

The app runs in your browser, but processing happens locally with MuPDF.js/WebAssembly. It does not upload files to a server.

## Run

```bash
npm install
npm run dev
```

Then open the local URL Vite prints, usually `http://127.0.0.1:5173`.

## Notes

- Proper redaction removes matching PDF content instead of drawing a black overlay.
- Use `Scan PDF` to review candidate overlays, then `Download redacted PDF` to generate, verify, and save the redacted file.
- If auto-detection misses something, use `Draw box` and drag on a PDF page to add a manual redaction candidate.
- Form SSN detection looks for labels such as `your social security number` and nearby 3-2-4 digit fields.
- Custom terms can be exact text or JavaScript-style regex such as `/\\bApt\\s+\\d+\\b/i`.
- Review every candidate before exporting. Pattern matching can miss scanned-image PDFs unless OCR has already added a text layer.
- Chrome and Edge support saving through the File System Access API. Other browsers fall back to a normal download.
- MuPDF.js is AGPL/commercial licensed. Personal local use is straightforward; distribution or commercial use may require reviewing AGPL obligations or buying a commercial license.
