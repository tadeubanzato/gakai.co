# Start Gakai

Read `.agents/skills/start-gakai/SKILL.md` and `.agents/skills/start-gakai/references/provider-api.md` completely before taking action; together they are the canonical Gakai project onboarding guide.

Before any project work, run the canonical safe synchronization workflow: check `git status --short`, run `git fetch origin --prune`, and only on a clean tree run `git pull --ff-only origin $(git branch --show-current)`. Do not switch, merge, rebase, stash, or overwrite local work automatically. Then preserve the provider boundary and runtime safety rules, and use the required validation workflow for any implementation.

