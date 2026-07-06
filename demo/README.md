# Conflict-free counter demo

A Next.js app that races the same parallel-increment workload against a
naive one-document counter and
[`convex-conflict-free-counter`](https://github.com/stack1ng/convex-conflict-free-counter).
Increments are fired as parallel HTTP mutations (independent transactions),
so contention on the naive counter is directly observable: Convex retries
conflicting mutations, and past its retry budget it rejects them outright.

Reference numbers against a local dev backend, 1,000 parallel increments:

| Mode          | Committed | Rejected (write conflicts) | Duration |
| ------------- | --------- | -------------------------- | -------- |
| Conflict-free | 1000/1000 | 0                          | ~1.3s    |
| Naive         | 845/1000  | 155                        | ~2.4s    |

Cloud deployments show a larger gap: higher per-commit latency widens the
conflict window.

## Run locally

The demo depends on the component package via `file:..`, so build it once
first (this installs its dev deps and emits `dist/`):

```sh
npm --prefix .. install          # build the component package
npm install --ignore-scripts     # install demo deps (skip the parent rebuild)
npx convex dev                   # terminal 1 — creates .env.local on first run
npm run dev                      # terminal 2 — Next.js on http://localhost:3000
```

If `.env.local` only contains `CONVEX_URL`, add a `NEXT_PUBLIC_CONVEX_URL`
line with the same value.

## Deploy (Vercel)

1. Import the repo and set **Root Directory** to `demo`.
2. Leave the install and build commands to `vercel.json` (in this directory):
   it builds the `file:..` component package with its dev deps, then runs
   `npx convex deploy --cmd 'npm run build'`.
3. Add `CONVEX_DEPLOY_KEY` (from a Convex production deployment) as a Vercel
   environment variable. `convex deploy` injects `NEXT_PUBLIC_CONVEX_URL`
   into the build automatically.

The parent package isn't published to npm, so `installCommand` in
`vercel.json` builds it from source — Vercel's production install would
otherwise skip its dev deps and the parent's `prepare` (tsc) would fail.
