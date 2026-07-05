# Publishing

## First publish (manual, one time)

npm requires the first publish of a new package to come from a logged-in
user:

```sh
npm login
npm run clean
npm ci
npm run build:codegen
npm run test && npm run typecheck && npm run lint
npm publish --access public
git tag v0.1.0
git push --follow-tags
```

## Subsequent releases

### Option A: from your machine (Convex component convention)

```sh
npm run release   # patch bump + publish + push tags
npm run alpha     # prerelease on the "alpha" dist-tag
```

The `preversion` script gates both on a clean build, tests, lint, and
typecheck. For minor/major bumps:

```sh
npm version minor && npm publish --access public && git push --follow-tags
```

### Option B: from CI

The [release workflow](.github/workflows/release.yml) publishes to npm (with
provenance) whenever a `v*` tag is pushed, after re-running tests, typecheck,
and lint.

One-time setup: create an npm
[automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
with publish rights and add it as the `NPM_TOKEN` repository secret:

```sh
gh secret set NPM_TOKEN
```

Then a release is just:

```sh
npm version patch  # updates CHANGELOG via the version script, creates the tag
git push --follow-tags
```

## Listing on the Convex components directory

Once published to npm with a public repo:

1. Optionally run the preflight checker:
   https://www.convex.dev/components/submit/check
2. Submit the component: https://www.convex.dev/components/submit
   (requires sign-in; you'll need the npm package URL and GitHub repo URL).
3. The Convex team reviews submissions on a rolling basis — typically within
   a few business days. Approved components appear on
   https://www.convex.dev/components with a "Community" badge.
