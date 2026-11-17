// Markdown → HTML on the server. The pipeline runs inside the Rust process
// through fetchlet, so the same unified / remark ecosystem a Node server would
// use renders the notes of a Rust application.

import GithubSlugger from "github-slugger";
import type { Element, ElementContent, Root as HastRoot } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";

export interface CodeBlock {
  code: string;
  language: string;
}

/**
 * Highlights the fenced code blocks of one note in a single call. Each result
 * is escaped HTML for the block's `<code>`, or null to keep the block plain.
 */
export type Highlight = (blocks: CodeBlock[]) => Promise<(string | null)[]>;

export interface Heading {
  depth: number;
  id: string;
  text: string;
}

export interface Rendered {
  html: string;
  title: string | null;
  headings: Heading[];
  tags: string[];
}

export interface RenderOptions {
  /** The note's workspace path, to resolve relative links and images. */
  path: string;
  highlight?: Highlight;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  // Raw HTML in a note is dropped, so a note cannot inject markup or script.
  .use(remarkRehype, { allowDangerousHtml: false });

// The only raw nodes left are the highlighter's escaped HTML.
const serializer = unified().use(rehypeStringify, { allowDangerousHtml: true });

export async function renderMarkdown(source: string, options: RenderOptions): Promise<Rendered> {
  const mdast = processor.parse(source);
  let frontmatter: Record<string, unknown> = {};
  const first = mdast.children[0];
  if (first?.type === "yaml") {
    frontmatter = readFrontmatter(first.value);
  }
  const hast = (await processor.run(mdast)) as HastRoot;

  const headings = collectHeadings(hast);
  rewriteLinks(hast, options.path);
  if (options.highlight) {
    await highlightCode(hast, options.highlight);
  }

  const title =
    typeof frontmatter.title === "string"
      ? frontmatter.title
      : (headings.find((heading) => heading.depth === 1)?.text ?? null);
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    html: serializer.stringify(hast),
    title,
    headings,
    tags,
  };
}

function readFrontmatter(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function textOf(node: ElementContent): string {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type === "element") {
    return node.children.map(textOf).join("");
  }
  return "";
}

function collectHeadings(tree: HastRoot): Heading[] {
  const slugger = new GithubSlugger();
  const headings: Heading[] = [];
  visit(tree, "element", (node: Element) => {
    const match = /^h([1-6])$/.exec(node.tagName);
    if (!match) {
      return;
    }
    const text = node.children.map(textOf).join("").trim();
    const id = slugger.slug(text);
    node.properties.id = id;
    headings.push({
      depth: Number(match[1]),
      id,
      text,
    });
  });
  return headings;
}

/** Resolves `target` against the directory of `from`, both workspace paths. */
export function resolveWorkspacePath(from: string, target: string): string | null {
  const segments = from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function rewriteLinks(tree: HastRoot, path: string) {
  visit(tree, "element", (node: Element) => {
    if (node.tagName === "a" && typeof node.properties.href === "string") {
      const href = node.properties.href;
      if (href.startsWith("#")) {
        return;
      }
      if (isExternal(href)) {
        node.properties.target = "_blank";
        node.properties.rel = ["noopener", "noreferrer"];
        return;
      }
      const [target, hash] = splitHash(decodeSafely(href));
      const resolved = resolveWorkspacePath(path, target);
      if (resolved === null) {
        return;
      }
      node.properties.href = /\.md$/i.test(resolved)
        ? "/notes/" + encodePath(resolved) + hash
        : "/files/" + encodePath(resolved) + hash;
    }
    if (node.tagName === "img" && typeof node.properties.src === "string") {
      const src = node.properties.src;
      if (isExternal(src)) {
        return;
      }
      const resolved = resolveWorkspacePath(path, decodeSafely(src));
      if (resolved !== null) node.properties.src = "/files/" + encodePath(resolved);
      node.properties.loading = "lazy";
    }
  });
}

function splitHash(href: string): [string, string] {
  const index = href.indexOf("#");
  return index < 0 ? [href, ""] : [href.slice(0, index), href.slice(index)];
}

function decodeSafely(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

async function highlightCode(tree: HastRoot, highlight: Highlight) {
  const targets: { code: Element; block: CodeBlock }[] = [];
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "pre") return;
    const code = node.children[0];
    if (code?.type !== "element" || code.tagName !== "code") return;
    const classes = Array.isArray(code.properties.className) ? code.properties.className : [];
    const language = classes
      .map(String)
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length);
    if (!language) return;
    targets.push({ code, block: { code: code.children.map(textOf).join(""), language } });
  });
  if (targets.length === 0) return;
  const highlighted = await highlight(targets.map((target) => target.block));
  targets.forEach(({ code }, index) => {
    const html = highlighted[index];
    if (html == null) return;
    code.children = [{ type: "raw", value: html } as unknown as ElementContent];
    code.properties.className = [...(code.properties.className as string[]), "highlighted"];
  });
}
