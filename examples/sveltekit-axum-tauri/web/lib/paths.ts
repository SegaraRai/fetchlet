/** The page of a note, with each path segment encoded. */
export function noteHref(path: string): string {
  return "/notes/" + path.split("/").map(encodeURIComponent).join("/");
}

/** A workspace path from what a person typed: `/` separators and an `.md` name. */
export function normalizeNewPath(input: string): string {
  const path = input
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return /\.md$/i.test(path) ? path : path + ".md";
}

export interface TreeNode {
  name: string;
  path: string;
  title?: string;
  children: TreeNode[];
}

/** Folders and notes as a tree, folders first, each level sorted by name. */
export function buildTree(notes: { path: string; title: string }[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const note of notes) {
    const segments = note.path.split("/");
    let node = root;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = node.children.find((candidate) => candidate.path === path);
      if (!child) {
        child = {
          name: segment,
          path,
          children: [],
        };
        node.children.push(child);
      }
      if (index === segments.length - 1) {
        child.title = note.title;
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(b.children.length > 0) - Number(a.children.length > 0) ||
        a.name.localeCompare(b.name),
    );
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}
