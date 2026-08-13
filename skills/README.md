# Agent skills

Skills that let a coding agent (Claude Code, Codex, or anything that reads Markdown instructions)
carry a Heron integration for you, end to end, inside your own repository.

| Skill | What it does |
|---|---|
| [`heron-setup`](./heron-setup/SKILL.md) | Installs `@theonaai/heron-sdk` and wires the guard into your agent's tool loop: credentials, client, session, contracts, catalog, evidence — turnkey. |

## Install

### Claude Code

Copy the skill into your skills directory — per project:

```bash
git clone --depth 1 https://github.com/theonaai/heron-sdk /tmp/heron-sdk
mkdir -p .claude/skills
cp -R /tmp/heron-sdk/skills/heron-setup .claude/skills/heron-setup
```

or globally for all projects:

```bash
mkdir -p ~/.claude/skills
cp -R /tmp/heron-sdk/skills/heron-setup ~/.claude/skills/heron-setup
```

Then run `/heron-setup` in Claude Code, inside the repository you want guarded.

### Codex

Codex reads instructions you point it at. Either save the skill as a custom prompt:

```bash
mkdir -p ~/.codex/prompts
curl -fsSL https://raw.githubusercontent.com/theonaai/heron-sdk/main/skills/heron-setup/SKILL.md \
  -o ~/.codex/prompts/heron-setup.md
```

and invoke `/heron-setup` — or simply tell it:

> Read https://raw.githubusercontent.com/theonaai/heron-sdk/main/skills/heron-setup/SKILL.md and
> follow it in this repository.

### Any other agent

The skill is plain Markdown with YAML frontmatter. Hand the file to the agent and ask it to follow
the phases in order. It needs file read/write and shell access in your repository — and it is
written to never print, log, or commit a secret.

## What "turnkey" means here

The skill does not paste a fixed snippet. It surveys your project first (runtime, tool loop shape,
run lifetime, multi-tenancy), picks the right integration shape (`guard.wrap` vs the
`decide`/`report` primitives), starts with the empty — safest — contract map, and ends with a
verification pass: partial configuration fails loudly, absent configuration changes nothing, and no
secret ever enters your git history.
