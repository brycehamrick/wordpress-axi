# Upstream catalog contribution runbook

How to list wordpress-axi in the shared AXI catalog on [axi.md](https://axi.md).
Do this only AFTER the npm package is published and dogfooded (soak period).
One-time per release; the entry stays.

Source: <https://github.com/kunchenguid/axi/blob/main/CONTRIBUTING.md>

## Preconditions

- [ ] `wordpress-axi` published on npm and installable via `npx -y wordpress-axi@latest`
- [ ] Public repo live at <https://github.com/brycehamrick/wordpress-axi>
- [ ] `no-mistakes` v1.30.1+ installed locally (`no-mistakes --version`)
- [ ] Node 24 + pnpm available for the axi repo toolchain

## Steps

1. Fork `kunchenguid/axi` on GitHub, then clone the PARENT repo locally and
   point `origin` at it (per CONTRIBUTING):

   ```sh
   git clone git@github.com:kunchenguid/axi.git
   cd axi
   git remote set-url origin git@github.com:kunchenguid/axi.git
   git checkout -b add-wordpress-axi
   ```

2. Append one entry to the `community` list in `catalog.yaml` (keep it in
   one-to-two-clause style like its neighbors):

   ```yaml
     - name: wordpress-axi
       url: https://github.com/brycehamrick/wordpress-axi
       author: brycehamrick
       domain: WordPress / CMS
       description: "Manage posts, pages, media, terms, comments, users, settings, plugins, and themes over the WordPress REST API, with draft-by-default writes, --confirm gates on publication and deletion, and token-efficient TOON output."
   ```

3. Regenerate the docs tables (Node 24 to match CI):

   ```sh
   pnpm install --frozen-lockfile
   pnpm run docs:gen
   ```

4. Run the same gates CI runs:

   ```sh
   pnpm run format:check
   pnpm run lint
   pnpm --dir packages/axi-sdk-js run build
   pnpm --dir packages/axi-sdk-js test
   ```

5. Commit exactly the three generated files (`catalog.yaml`, `README.md`,
   `docs/index.html`) with a conventional message (`docs: add wordpress-axi
   to catalog`). Never hand-edit the generated table regions.

6. Initialize the gate with YOUR fork as push target, then push THROUGH it:

   ```sh
   no-mistakes init --fork-url git@github.com:brycehamrick/axi.git
   git push no-mistakes
   no-mistakes   # attach to the pipeline, fix findings or auto-fix
   ```

7. When the pipeline passes it pushes to the fork and opens the PR against
   `kunchenguid/axi` automatically, carrying the required signature. The
   `Require no-mistakes` and `Guard generated files` checks must both pass.

## Notes

- Do NOT edit `packages/axi-sdk-js/CHANGELOG.md` or
  `.release-please-manifest.json` (release-please owns those; CI fails PRs
  that touch them).
- Questions: open an issue or use the AXI Discord (link in CONTRIBUTING).
