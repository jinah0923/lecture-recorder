// KaTeX's contrib extensions ship without type declarations. Both are imported
// only for their side effects: mhchem registers \ce{...} (lib/markdown.tsx,
// lib/pdfExport.ts), and copy-tex rewrites copied formulas back to their
// LaTeX source (components/ReviewPanel.tsx).
declare module "katex/contrib/mhchem";
declare module "katex/contrib/copy-tex";
