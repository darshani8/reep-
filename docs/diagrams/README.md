# Architecture poster

`reep-architecture-a3.svg` (source of truth), `.pdf` (print) and `.png`
(150 dpi preview) are the complete system architecture on one A3 sheet —
people and roles, the AWS edge, compute, state, the AI plane, observability
and traceability, the interview call recorder, and the invariants that must
not be broken.

## Printing

Print the **PDF** at **A3 landscape (420 × 297 mm), 100 % scale, no margins /
"actual size"** — do not let the driver "fit to page", which shrinks the body
text below comfortable reading size. Body text is ≈ 2.4 mm tall, which reads
from about a metre away. On A4 it is legible but cramped; A3 is the design
target. The SVG is vector, so it also scales cleanly to A2 or A1 if you want a
bigger wall copy.

## Regenerating

The poster is generated, not drawn — so it can be kept honest as the system
changes:

```bash
python tools/diagrams/render_architecture.py     # → docs/diagrams/*.svg
```

The generator validates its own geometry and refuses to pass silently: any card
whose text would clip, or that would fall off the canvas, is reported on stdout
("clean" when all is well). To refresh the PDF and PNG afterwards, render the
SVG through any browser's print-to-PDF at A3 landscape, or:

```bash
chromium --headless --no-pdf-header-footer --print-to-pdf=out.pdf page.html
pdftoppm -png -r 150 -singlefile out.pdf reep-architecture-a3
```
