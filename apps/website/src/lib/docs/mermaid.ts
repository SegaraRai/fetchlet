import type { MdastPluginInput } from "@cloudflare/nimbus-docs/types";
import { renderMermaidSVG } from "beautiful-mermaid";

let nextDiagramId = 0;

/**
 * Renders a Mermaid diagram to a standalone inline SVG whose styles come from
 * `docs.css` (no inline `<style>` element or external font imports, keeping the
 * site's strict `style-src 'self'` CSP intact) and whose marker IDs are unique
 * per diagram.
 */
export function renderDiagramSvg(source: string, idPrefix = `mermaid-${nextDiagramId++}`): string {
  const raw = renderMermaidSVG(source, {
    font: "Instrument Sans",
    padding: 28,
    transparent: true,
  });

  // Remove the embedded <style> block (which contains an external Google Fonts
  // @import and inline rules blocked by CSP) and the root inline style attribute;
  // `docs.css` supplies all `--_*` tokens from the site theme.
  const withoutStyle = raw
    .replace(/<style>[\s\S]*?<\/style>\s*/g, "")
    .replace(/(<svg\b[^>]*?)\s+style="[^"]*"/, "$1");

  // Scope marker/clip IDs so multiple diagrams on one page never collide.
  const scoped = withoutStyle
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${idPrefix}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${idPrefix}-${id})`);

  return `<figure class="mermaid-diagram" role="img" aria-label="Diagram">${scoped}</figure>`;
}

/**
 * Replaces `mermaid` fenced code blocks with statically rendered SVGs at build
 * time. Markdown alternates (`index.md`, `llms.txt`) still receive the original
 * Mermaid source from the content files.
 */
export const mermaidPlugin: MdastPluginInput = {
  name: "fetchlet-mermaid",
  code(node, context) {
    if ((node.lang ?? "").toLowerCase() !== "mermaid") {
      return;
    }
    context.replaceNode(node, {
      type: "html",
      value: renderDiagramSvg(node.value),
    });
  },
};
