import { describe, expect, it } from "vite-plus/test";

import { renderDiagramSvg } from "./mermaid";

describe("renderDiagramSvg", () => {
  it("renders a flowchart to inline SVG without style elements or external imports", () => {
    const html = renderDiagramSvg("flowchart LR\n  A[Request] --> B[Response]", "test-0");
    expect(html).toContain('<figure class="mermaid-diagram"');
    expect(html).toContain("<svg ");
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).toContain('id="test-0-arrowhead"');
    expect(html).toContain("url(#test-0-arrowhead)");
  });
});
