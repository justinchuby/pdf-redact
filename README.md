# Local PDF Redactor

A local-only PDF redaction web app for SSN, EIN, ITIN, and other tax-document identifiers.

The app runs entirely in your browser using MuPDF.js/WebAssembly. **Files are never uploaded to a server.**

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

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**, primarily because it uses [MuPDF.js](https://mupdf.com/), which is AGPL-3.0 licensed.

Under AGPL-3.0, anyone who interacts with this software over a network is entitled to receive the corresponding source code. The full source is available in this repository.

If you need to use MuPDF under a different license (e.g., for commercial or proprietary use), contact [Artifex](https://artifex.com/) for a commercial license.
