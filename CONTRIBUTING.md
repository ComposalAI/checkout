# Contributing

Use Node 24 and run `npm ci`. Add a test for changed behavior, then run:

```sh
npm test -- --runInBand
npm run build
```

Commit the rebuilt `dist/` files with source changes. Keep changes to the
standard checkout implementation small so upstream security fixes remain easy
to incorporate. [UPSTREAM.md](UPSTREAM.md) records the source version.

Open pull requests against `master` in `ComposalAI/checkout`.
