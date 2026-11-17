<script lang="ts">
  import { buildTree, noteHref, type TreeNode } from "#lib/paths.ts";

  let { notes, current }: { notes: { path: string; title: string }[]; current?: string } = $props();

  const tree = $derived(buildTree(notes));
</script>

{#snippet branch(nodes: TreeNode[])}
  <ul>
    {#each nodes as node (node.path)}
      <li>
        {#if node.children.length > 0}
          <details open={!current || current.startsWith(node.path + "/") || nodes.length < 6}>
            <summary>{node.name}</summary>
            {@render branch(node.children)}
          </details>
        {:else}
          <a
            href={noteHref(node.path)}
            aria-current={current === node.path ? "page" : undefined}
            title={node.path}>{node.title ?? node.name}</a
          >
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<nav class="tree" aria-label="ノート">
  {#if tree.length === 0}
    <p class="muted">ノートがありません。</p>
  {:else}
    {@render branch(tree)}
  {/if}
</nav>
