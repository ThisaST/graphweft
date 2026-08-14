# Publishing Graphweft to the VS Code Marketplace

This guide takes you from a clean checkout to a published extension. It also
covers the two Graphweft-specific gotchas (pnpm symlinks and the runtime
`node_modules` assets) that will otherwise produce a broken `.vsix`.

> **TL;DR**
> ```bash
> npm i -g @vscode/vsce          # one-time
> npm install                    # flat node_modules — see "pnpm gotcha"
> npm run compile && npm test    # green build
> vsce package                   # → graphweft-copilot-chat-0.1.0.vsix
> # install the .vsix locally and smoke-test it, THEN:
> vsce login <your-publisher-id>
> vsce publish
> ```

---

## 1. Prerequisites

| Requirement | Why |
| --- | --- |
| **Node 18+** | vsce + the build toolchain. |
| **`@vscode/vsce`** | The official packaging/publishing CLI. Install globally: `npm i -g @vscode/vsce`. |
| **An Azure DevOps account** | The Marketplace authenticates publishers through Azure DevOps (it's free). |
| **A Marketplace publisher** | The identity your extension ships under. |

---

## 2. Create your publisher (one-time)

1. Sign in at **https://dev.azure.com** with the Microsoft account you want to own the extension.
2. Go to **https://marketplace.visualstudio.com/manage** and click **Create publisher**.
3. Pick a **publisher ID** (lowercase, no spaces — e.g. `acme-tools`). This is permanent and public.
4. Fill in the display name and you're done.

### Create a Personal Access Token (PAT)

vsce authenticates with a PAT, not your password.

1. In Azure DevOps → click your avatar → **Personal access tokens** → **New Token**.
2. **Organization:** select **All accessible organizations** (important — a token scoped to one org will fail).
3. **Scopes:** click **Show all scopes** → **Marketplace** → check **Manage**.
4. Set an expiry, create it, and **copy the token now** (it's shown once).

Store it somewhere safe (a password manager). You'll paste it into `vsce login`.

---

## 3. Point package.json at your real publisher

The repo currently ships with placeholders that **must** be replaced before you publish:

```jsonc
// package.json
"publisher": "local-first",                                   // ← your publisher ID
"repository": { "url": "https://github.com/your-org/graphweft-copilot-chat.git" }, // ← your repo
"bugs": { "url": "https://github.com/your-org/graphweft-copilot-chat/issues" }     // ← your repo
```

Change `publisher` to the exact ID you created in step 2 — the Marketplace
rejects a publish if it doesn't match. Update the `repository`/`bugs` URLs to
your real Git remote (the Marketplace page renders a "Repository" link from it).

The following fields are **already set correctly** and need no changes:

- `name`, `displayName`, `description`, `version` (`0.1.0`)
- `icon: "media/icon.png"` → the logo shown in the Marketplace and the chat participant
- `license: "MIT"` (with a `LICENSE` file at the repo root)
- `engines.vscode: "^1.90.0"`, `categories`, `keywords`, `galleryBanner`

---

## 4. The pnpm gotcha (read this before packaging)

This repo is developed with **pnpm**, which makes `node_modules/cytoscape` and
`node_modules/sql.js` **symlinks** into `.pnpm/`. `vsce` does **not** reliably
follow those symlinks, so a VSIX packaged from a pnpm tree can ship **without
Cytoscape or the sql.js WASM** — the graph view and the index would both break
at runtime.

**Two safe options:**

- **Option A — package from a flat `node_modules` (simplest):**
  ```bash
  rm -rf node_modules
  npm install            # npm produces a flat, non-symlinked tree
  npm run compile
  vsce package
  ```
  After packaging you can `pnpm install` again to return to your dev setup.

- **Option B — bundle the extension (best long-term):** add an esbuild/webpack
  step that inlines `out/**` and copies `cytoscape.min.js` + `sql-wasm.wasm`
  into a `dist/` folder, then ship only `dist/`. This shrinks the VSIX and
  removes the symlink problem entirely. (Not wired up yet — Option A is fine for
  the first release.)

---

## 5. What ships in the VSIX (and what must NOT be stripped)

`vsce` includes everything **except** what `.vscodeignore` lists, and it
automatically prunes `devDependencies` while keeping production `dependencies`.

Graphweft loads two things from `node_modules` **at runtime**, so they must end
up in the package:

| Asset | Loaded by | Loaded how |
| --- | --- | --- |
| `node_modules/cytoscape/dist/cytoscape.min.js` | `src/viz/graphWebview.ts` | webview `<script>` via `asWebviewUri` |
| `node_modules/sql.js/dist/sql-wasm.wasm` | `src/graph/sqliteGraphStore.ts` | `require.resolve('sql.js/dist/..')` |

The committed `.vscodeignore` keeps these explicitly. **Verify** they're in the
package before you publish:

```bash
vsce ls | grep -E "cytoscape|sql-wasm|icon.png|out/extension.js"
```

You should see `media/icon.png`, `out/extension.js`,
`node_modules/cytoscape/dist/cytoscape.min.js`, and a `sql.js/dist/*.wasm`. If
any are missing, re-check step 4 (pnpm) and `.vscodeignore`.

### What must NOT ship: the local embedding runtime

`@huggingface/transformers` (and its `onnxruntime-node`/`sharp` native
binaries — hundreds of MB) is a production dependency **for the headless
CLI/MCP distribution only**. The extension's semantic path talks to Ollama over
HTTP and never imports it, and `.vscodeignore` excludes the whole tree. After
packaging, confirm none of it leaked in:

```bash
vsce ls | grep -E "huggingface|onnxruntime|sharp" && echo "LEAK — fix .vscodeignore" || echo "clean"
```

---

## 6. Build, package, and smoke-test locally

```bash
npm run compile      # tsc -p .  → out/
npm test             # the four Node test suites should all print "passed"
vsce package         # → graphweft-copilot-chat-0.1.0.vsix
```

Install the VSIX into a clean VS Code and exercise the real features — this
catches packaging bugs the unit tests can't:

```bash
code --install-extension graphweft-copilot-chat-0.1.0.vsix
```

Then in that window confirm:

1. **`@graphweft /help`** lists the slash commands (participant + icon loaded).
2. **`@graphweft /viz`** opens the graph — proves Cytoscape shipped.
3. **`Graphweft: Build Local Index`** completes — proves the sql.js WASM shipped.
4. The **Graphweft sidebar** and **Privacy Center** open without errors.

Uninstall the test copy when done:
`code --uninstall-extension <publisher>.graphweft-copilot-chat`.

---

## 7. Publish

```bash
vsce login <your-publisher-id>   # paste the PAT from step 2
vsce publish                     # packages + uploads in one step
```

`vsce publish` reads `version` from `package.json`. To bump and publish in one
go: `vsce publish patch` (also `minor` / `major`), which edits `package.json`,
tags, and uploads.

The extension appears at
`https://marketplace.visualstudio.com/items?itemName=<publisher>.graphweft-copilot-chat`
within a minute or two. Users install with:

```bash
code --install-extension <publisher>.graphweft-copilot-chat
```

---

## 8. Updating later

1. Make changes, `npm run compile && npm test`.
2. Bump the version: `vsce publish patch` (or edit `version` and run `vsce publish`).
3. The Marketplace shows the new version; installed clients auto-update.

---

## 9. Alternatives & extras

- **Open VSX** (for VSCodium / Cursor / Gitpod / Theia users): publish the same
  VSIX with [`ovsx`](https://github.com/eclipse/openvsx): `npx ovsx publish *.vsix -p <openvsx-token>`.
- **Private distribution (no Marketplace):** just hand teammates the `.vsix`
  and have them run `code --install-extension <file>.vsix`. Given Graphweft's
  local-first/privacy framing, this is a perfectly good way to roll it out
  internally without ever listing it publicly.
- **CI publishing:** store the PAT as a secret and run `vsce publish -p $VSCE_PAT`
  in your pipeline.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Missing publisher name` | `publisher` field still placeholder, or not logged in. |
| Graph view blank / "cytoscape is not defined" | Cytoscape didn't ship — repackage from a flat `npm install` tree (step 4) and re-check `vsce ls`. |
| Index build throws on WASM load | `sql.js/dist/*.wasm` didn't ship — same fix as above. |
| `401 Unauthorized` on publish | PAT expired or not scoped to **Marketplace → Manage / All accessible organizations**. |
| `vsce package` warns about `repository` | Set a real `repository.url` (step 3). A warning won't block packaging, but fixing it gives users a source link. |
| VSIX is huge | You're shipping a pnpm/full `node_modules`. Use Option B (bundling) or confirm `.vscodeignore` is excluding `src/`, maps, and tests. |
