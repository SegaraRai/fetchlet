---
title: Coding agents
slug: docs/agents
description: Let a coding agent set up fetchlet or work in a fetchlet project, using the documentation and skills in the fetchlet package.
---

The `fetchlet` npm package includes this documentation as Markdown files in
`node_modules/fetchlet/docs/`. It also includes skills for coding agents. An
agent that reads these files uses the documentation of the installed version.

## Start with a prompt

Give this prompt to your agent in the JavaScript project of your application:

```text
Set up fetchlet in this project. If the fetchlet package is not installed,
install it as a development dependency with the project's package manager.
Then read node_modules/fetchlet/docs/agents.md and follow its instructions
for agents.
```

The agent finds the framework, configures its adapter and, when you agree,
adds a Rust host that serves the build.

## What the package includes

| Path                     | Content                                                   |
| ------------------------ | --------------------------------------------------------- |
| `docs/`                  | This documentation as Markdown                            |
| `docs/llms.txt`          | Index of every bundled Markdown page with relative paths  |
| `skills/setup-fetchlet/` | A skill that adds fetchlet and a Rust host to a project   |
| `skills/fetchlet/`       | A skill for everyday work in a project that uses fetchlet |
| `AGENTS_TEMPLATE.md`     | A section for the instruction file of your project        |

The Rust crates do not include these files. A Rust project without a
JavaScript application can use this website, as
[Read the documentation online](#read-the-documentation-online) describes.

## Instructions for agents

1. Inspect the project. Find the package manager, the framework and its
   build tool, and any Rust host that already exists. In a monorepo, find the
   application that the user means.
2. Choose a skill and follow its `SKILL.md`. The skills are in
   `node_modules/fetchlet/skills/`:
   - Use `setup-fetchlet` when the project does not build a fetchlet artifact
     yet.
   - Use `fetchlet` when the project already uses fetchlet.
3. Tell the user which skill you chose and why, in one sentence.

## Install the skills

Agents can read the skills from `node_modules/fetchlet/skills/` without
installation. To let your agent load them automatically, link them into its
skill directory, such as `.claude/skills/` for Claude Code or `.agents/skills/`
for Codex:

```sh
mkdir -p .claude/skills
ln -s ../../node_modules/fetchlet/skills/fetchlet .claude/skills/fetchlet
```

A link keeps the skill in sync with the installed version. Copy the directory
instead when your system does not support links.

## Add project instructions

Add the contents of `node_modules/fetchlet/AGENTS_TEMPLATE.md` to the
instruction file of your project, such as `AGENTS.md` or `CLAUDE.md`. The
section tells agents in later sessions that the project uses fetchlet and
where its documentation is.

## Read the documentation online

Every page of this website has a **View as Markdown** link. Give your agent the
[documentation index](/docs/llms.txt), or retrieve the
[full documentation](/llms-full.txt) in one request. The Rust API reference is
on [docs.rs](https://docs.rs/fetchlet).
