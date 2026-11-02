# AlcorQR

![AlcorQR](../../screenshots/AlcorQR.png)

A QR code designer: colours, module styles, error-correction level, quiet zone and an optional
centre logo, exported as PNG (up to 4096 px) or SVG.

## How it works

| File | Role |
|---|---|
| `alcor-qr-core.js` | Validation and rendering rules: colour contrast, options, matrix, export. No DOM. |
| `alcor-qr.js` | The designer UI and live preview. |
| `vendor/alcor-qr-engine.js` | QR encoding (third party, MIT and Apache-2.0, notices alongside). |

## The hard parts

- **Designs that still scan.** `contrastRatio` and `validatePalette` compute WCAG relative
  luminance between modules and background and warn before you export a code a phone can't read.
  The centre logo is capped at the share of the code that error correction can recover.
- **Untrusted logos.** Uploaded SVG marks are checked and rejected if they contain scripts,
  animation, embedded pages, event handlers or external references.
- **Vector output.** SVG export builds the code from paths (`createSvg`, `svgModule`, `svgFinder`,
  `roundedRectPath`) with sanitised text and CSS, so it stays sharp at any print size.

## Run

Serve `AlcorApps/web` with any static server and open `AlcorQR/`.
