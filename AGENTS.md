# Codex Project Memory

- Primary work guide: read and follow `CHATGPT.md` first.
- Long-term OZGuard memory is in MemPalace at `/Users/firay/.mempalace/palace`, wing `ozguard`.
- Before substantial OZGuard work, load context with `mempalace wake-up --wing ozguard` and use targeted `mempalace search "..." --wing ozguard`.
- MemPalace/Chroma may need elevated filesystem access in the Codex sandbox because reads can open SQLite/HNSW with write locks.
- Claude Code memory was migrated from `/Users/firay/.claude/projects/-Users-firay-china-banned-ozguard`.
- Speak concise Russian by default.
- For OZGuard releases, update both `CHANGELOG.md` and `CHANGELOG-USER.md`.
- Do not run `git add`, `git commit`, `git push`, `git reset`, database migrations, seeds, or destructive DB commands unless the user explicitly asks to run them. Provide commands as text when needed.
