// Remote functions: typed calls from components to the SvelteKit server, which
// runs inside the Rust process and reaches the Rust API in-process. The types
// flow from the Rust handlers through OpenAPI to these functions and on to
// the components that call them.
import { command, form, query } from "$app/server";
import { error, invalid, redirect } from "@sveltejs/kit";
import * as v from "valibot";
import { render } from "#lib/server/render.ts";
import { rust } from "#lib/server/rust.ts";
import { noteHref, normalizeNewPath } from "#lib/paths.ts";

const notePath = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));

export const getWorkspace = query(async () => {
  const { data } = await rust.workspaceInfo({ throwOnError: true });
  return data;
});

export const getNotes = query(async () => {
  const { data } = await rust.listNotes({ throwOnError: true });
  return data;
});

/** A note's source and version, for the editor. */
export const getNote = query(notePath, async (path) => {
  const { data, error: failure, response } = await rust.getNote({ query: { path } });
  if (!data) error(response?.status === 400 ? 400 : 404, failure?.error ?? "not found");
  return data;
});

/** A note rendered to HTML on the server, with its outline and tags. */
export const getRenderedNote = query(notePath, async (path) => {
  const { data: note, error: failure, response } = await rust.getNote({ query: { path } });
  if (!note) error(response?.status === 400 ? 400 : 404, failure?.error ?? "not found");
  const rendered = await render(path, note.content);
  return {
    path: note.path,
    version: note.version,
    modified: note.modified,
    title: rendered.title ?? note.title,
    html: rendered.html,
    headings: rendered.headings,
    tags: rendered.tags,
  };
});

export const searchNotes = query(
  v.object({ q: v.pipe(v.string(), v.maxLength(200)), limit: v.optional(v.number()) }),
  async ({ q, limit }) => {
    if (!q.trim()) return [];
    const { data } = await rust.search({ query: { q, limit }, throwOnError: true });
    return data;
  },
);

/** Renders unsaved text for the editor's preview. */
export const renderPreview = command(
  v.object({ path: notePath, content: v.string() }),
  async ({ path, content }) => {
    const { html } = await render(path, content);
    return html;
  },
);

export const saveNote = form(
  v.object({
    path: notePath,
    content: v.string(),
    base_version: v.string(),
    /**
     * Sent by "overwrite" after a conflict: the version on disk now, which the
     * save replaces, or empty to recreate a note that was deleted.
     */
    overwrite: v.optional(v.string()),
  }),
  async ({ path, content, base_version, overwrite }, issue) => {
    const base = overwrite === undefined ? base_version : overwrite || null;
    const {
      data,
      error: failure,
      response,
    } = await rust.saveNote({
      body: { path, content, base_version: base },
    });
    if (response?.status === 409) {
      // The editor offers to overwrite with the version that is on disk now.
      return { conflict: failure?.conflict?.current_version ?? null };
    }
    if (!data) invalid(issue.content(failure?.error ?? "Could not save the note"));
    // After a successful submission SvelteKit refreshes the queries on the page.
    redirect(303, noteHref(path));
  },
);

export const createNote = form(
  v.object({ path: v.pipe(v.string(), v.trim(), v.minLength(1, "Enter a name")) }),
  async (input, issue) => {
    const path = normalizeNewPath(input.path);
    const title = path.replace(/\.md$/i, "").split("/").pop()!;
    const {
      data,
      error: failure,
      response,
    } = await rust.saveNote({
      body: { path, content: `# ${title}\n\n`, base_version: null },
    });
    if (response?.status === 409) invalid(issue.path("A note with this name already exists"));
    if (!data) invalid(issue.path(failure?.error ?? "Could not create the note"));
    redirect(303, noteHref(path) + "/edit");
  },
);

export const deleteNote = form(
  v.object({ path: notePath, version: v.string() }),
  async ({ path, version }) => {
    const { error: failure, response } = await rust.deleteNote({ query: { path, version } });
    if (!response?.ok) invalid(failure?.error ?? "Could not delete the note");
    redirect(303, "/");
  },
);
