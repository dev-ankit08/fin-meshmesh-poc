# Project notes for Claude Code
Start with HANDOFF.md: it has the goal, current state, rules and the step-by-step live test plan for v2 (generic Salesforce setup requests).
- Run `npm test` before and after every change (Node >= 20.12; 37 tests at handoff).
- Never print or commit `.env`, `data/`, `config/customers.json` or any token. The human does all sign-ins in the browser.
- Dev Edition / sandbox orgs only.
