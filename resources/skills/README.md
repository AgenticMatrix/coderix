# CoderAgent Skills

Skills are optional, installable modules that add capabilities to the AI agent.

## Directory Structure

```
resources/skills/           ← source (shipped with the project)
└── <skill-name>/
    ├── SKILL.md            ← skill definition (YAML frontmatter + Markdown body)
    └── ...                 ← supporting files (scripts, configs, etc.)

~/.coder/skills/            ← installed target (copied on first run)
└── <skill-name>/
    ├── SKILL.md
    └── ...
```

## SKILL.md Format

```markdown
---
name: my-skill
description: One-line description of what this skill does.
version: "1.0"
triggers: [keyword1, keyword2]
tools: [bash, web-fetch]
tags: [category1, category2]
author: your-name
---

# Skill Title

## Setup

...

## Operations

...

## Examples

...

## Troubleshooting

...
```

### Frontmatter Fields

| Field | Required | Format | Description |
|-------|:---:|--------|-------------|
| `name` | ✓ | kebab-case | Unique skill identifier |
| `description` | ✓ | string | One-line summary for system prompt |
| `version` | ✗ | semver | Version number |
| `triggers` | ✗ | `[word1, word2]` | Inline array of trigger keywords |
| `tools` | ✗ | `[tool1, tool2]` | Tools the skill uses |
| `tags` | ✗ | `[tag1, tag2]` | Categorization |
| `author` | ✗ | string | Author name |

> **Note**: Arrays must use inline format `[a, b, c]`, not multi-line YAML lists.

## How Skills Work

1. **Install**: `install.sh` copies `resources/skills/` → `~/.coder/skills/`
2. **Discover**: System prompt lists available skills (name + description + triggers)
3. **Invoke**: Agent calls the `skill` tool → loads SKILL.md body → follows instructions
4. **Execute**: Skill instructions tell the agent which tools to use and how

## Built-in Skills

| Skill | Description |
|-------|-------------|
| [web-bridge](web-bridge/SKILL.md) | Browser automation via CDP — navigate, click, type, screenshot, form fill, JS execution, network capture. Supports Chrome extension and direct CDP modes. |

## Creating a New Skill

1. Create `resources/skills/<name>/SKILL.md`
2. Add supporting files (scripts, configs) to the same directory
3. Test: copy to `~/.coder/skills/<name>/`, restart CoderAgent, type `/skill`
4. All files in the skill directory are copied to `~/.coder/skills/<name>/` on install
