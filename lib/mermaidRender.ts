"use client";

// Renders a ```mermaid block (an AI-drawn diagram in the lecture note) to SVG.
// Shared by the on-screen viewer (components/MermaidDiagram.tsx) and the PDF
// export (lib/pdfExport.ts). mermaid is large, so it's loaded only when a
// note actually contains a diagram.

let renderCount = 0;

// Fonts the app already uses, so Korean labels match the surrounding note.
const DIAGRAM_FONT = "'Apple SD Gothic Neo', 'Malgun Gothic', -apple-system, BlinkMacSystemFont, sans-serif";

export async function renderMermaidSvg(
  code: string,
  options: { dark: boolean; htmlLabels: boolean },
): Promise<string | null> {
  const mermaid = (await import("mermaid")).default;
  // securityLevel "strict": the diagram source comes from the AI, so mermaid
  // sanitizes labels and disables click handlers / links in the output.
  // htmlLabels: false draws labels as plain SVG text — needed for the PDF,
  // where the SVG is drawn into a canvas (HTML labels use <foreignObject>,
  // which some browsers refuse to rasterize).
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: options.dark ? "dark" : "default",
    fontFamily: DIAGRAM_FONT,
    htmlLabels: options.htmlLabels,
    flowchart: { htmlLabels: options.htmlLabels },
  });
  // A syntax error is reported as null (the caller shows the source instead)
  // rather than mermaid's own error graphic.
  if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
  // A fresh id per render: the SVG's internal styles are scoped by it, and the
  // same diagram can be on screen while it's re-rendered (theme change) or
  // rendered again for a PDF.
  const id = `mermaid-diagram-${++renderCount}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch {
    return null;
  } finally {
    // mermaid renders in a temporary element it doesn't always clean up on
    // failure.
    document.getElementById(`d${id}`)?.remove();
  }
}
