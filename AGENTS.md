# Impostor — agent notes

- After making changes, run `npm run lint`, `npm run typecheck`, and `npm test`; fix all
  errors before calling work complete.
- `npm run build` must pass before `npm start` serves new UI.
- `@shadcn/lint` rules in `eslint.config.mjs` govern Tailwind classes in `app/`; add theme
  tokens in `app/index.css` instead of arbitrary values.
- Server code (`server/`) runs directly under Node's type stripping: no enums, no
  parameter properties, and imports must include the `.ts` extension.
