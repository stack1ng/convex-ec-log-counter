# Developing guide

## Running locally

```sh
npm i
npm run dev
```

## Testing

```sh
npm run clean
npm run build
npm run typecheck
npm run lint
npm run test
```

## Building a one-off package

```sh
npm run clean
npm ci
npm pack
```

## Releasing

Releases are published **only** by CI when a `v*` tag is pushed, via npm
Trusted Publishing (no token). To cut one:

```sh
npm run release      # prompts for the new version + notes, then pushes the tag
npm run alpha        # prerelease bump on the "alpha" dist-tag (no prompt)
```

`npm run release` shows the current version and asks what to bump to
(`x.y.z`, or `patch` / `minor` / `major`). See [PUBLISHING.md](PUBLISHING.md)
for the full flow.
