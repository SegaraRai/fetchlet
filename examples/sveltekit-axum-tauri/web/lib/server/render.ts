import { renderMarkdown, type Highlight, type Rendered } from "./markdown";
import { rust } from "./rust";

/**
 * Code blocks are highlighted by syntect in Rust: the JavaScript renderer
 * hands every block of a note to the Rust API in one in-process call.
 */
const highlightInRust: Highlight = async (blocks) => {
  const { data } = await rust.highlight({ body: { blocks }, throwOnError: true });
  return data.blocks;
};

export function render(path: string, content: string): Promise<Rendered> {
  return renderMarkdown(content, { path, highlight: highlightInRust });
}
