# Tony's Working Preferences
_Last updated: 2026-04-23_

## Communication
- Prefers concise responses, no excessive explanation
- Likes copy buttons on Claude Code prompts — always provide a widget with a copy button
- Wants to preview visuals (animations, UI changes) before committing to code
- Says "Continue from where you left off" when a session gets cut off — just resume silently

## Workflow
- Uses Claude Code (CLI) to run builds and git push — Claude provides the prompt, Tony pastes it
- Always ends with: `npm run build` → `git commit` → `git push origin main`
- Prefers a single build+commit+push prompt rather than separate steps
- Tony opens URLs in browser (not PWA) to test fresh deployments

## Visual / UI
- Loves kawaii/cute style for fun features (break screen animation)
- Wants previews shown before finalizing animations or UI changes
- Prefers transparent backgrounds on images — no black boxes
- Color scheme: pink/red for the main app, sky blue for staff portal break screen

## Code Style
- Keep changes minimal and targeted — don't refactor things that aren't broken
- Always check for file corruption (null bytes) in AppContext.tsx if syncs mysteriously break
- Provide copy buttons on all Claude Code prompts using the widget tool
