## What

<!-- A short description of the change. -->

## Why

<!-- The problem it solves. Link the issue: Closes #123 -->

## How it was tested

<!-- Steps, and the model tier you tested with if relevant. -->

## Screenshots

<!-- For UI changes. -->

## Checklist

- [ ] `npm run check` passes (typecheck, lint, format, tests)
- [ ] `npm run build` passes
- [ ] New migration in `supabase/migrations/` (with RLS and a test) if the schema changed
- [ ] Docs updated if behaviour or configuration changed
- [ ] No secrets in code, logs or responses; tenant data stays behind `withUser`
