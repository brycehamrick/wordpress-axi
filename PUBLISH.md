# Publish runbook

Everything is prepared; manual steps that need interactive auth (browser
login and 2FA) cannot be automated from here.

## 1. GitHub repo

The repo already exists at <https://github.com/brycehamrick/wordpress-axi>.
After merging the Node rewrite to `main`:

```sh
git push origin main
git tag v1.0.0 && git push --tags   # optional
```

## 2. Publish to npm

From a fresh clone (install dev dependencies first - a fresh clone has no
`node_modules` and no `dist/`, so the gates would fail):

```sh
npm ci               # install dev dependencies (tsc, vitest, ...)
npm login            # browser + 2FA
npm publish          # access is already "public" in package.json
```

`prepublishOnly` runs typecheck, tests, the skill check, and the build
automatically - `npm publish` cannot ship a package that fails them. The
name `wordpress-axi` was verified unclaimed on the npm registry before
the first publish.

Verify from a clean directory:

```sh
npx -y wordpress-axi@latest --version   # expect 1.0.0
npx -y wordpress-axi@latest me          # with the WORDPRESS_* env exported
```

## 3. Soak, then catalog PR

- Install the skill: `npx -y skills@latest add brycehamrick/wordpress-axi --skill wordpress-axi -g`
- Dogfood real workflows against a real site for a few days.
- Then follow [docs/upstream-catalog.md](docs/upstream-catalog.md) to add
  wordpress-axi to the axi.md catalog through no-mistakes.

## Release hygiene (every future release)

```sh
npm run typecheck && npm test && npm run build
# bump version in package.json, commit as "chore: release v<x.y.z>"
npm publish
git push --tags
```

CI (`.github/workflows/ci.yml`) runs the same gates on mac/win/linux plus
gitleaks once Actions is enabled on the repo.
