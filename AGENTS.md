# Contributor instructions

This repository is a standalone, provider-neutral stdio MCP server. User
instructions take precedence; make the smallest change that satisfies them.

- Do not publish, deploy, bump versions, rotate the pinned signing KID, or alter
  payment/signing behavior unless the user explicitly requests it.
- Preserve fail-closed manifest verification, price/network/asset/payee binding,
  spend reservations, and conservative settlement accounting.
- Never log or return wallet keys or payment authorization headers.
- Keep client documentation model-neutral. Codex, GPT-6 Astra, Claude, and other
  MCP clients are examples, not runtime dependencies or entitlement promises.
- `src/` is canonical and `dist/` is committed for package consumers. Rebuild
  `dist/` after every source change and verify that no generated diff remains.
- Before handing off code changes, run `npm test`, `npm run typecheck`,
  `npm run verify:dist`, and `npm run pack:check`.
