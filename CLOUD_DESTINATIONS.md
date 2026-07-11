# Cloud Destinations

How the pipeline publishes exported assets to Local, Dropbox, OneDrive, and Google Drive, and how to connect each one.

Configured in the app under **Settings → Cloud Destinations**.

---

## How publishing works

- Each destination has: **Identity** (name, role — `internal` or `client`), **Type**, **Credentials**, **Remote folder**, and **Export options**.
- **Every asset is its own push.** When a pipeline run finishes collecting assets, the app loops over every active (connected, token present) cloud destination and uploads **every asset individually** — one upload API call per file per destination, at concurrency 2. There is no zip/batch upload.
- **Generate link** (per destination toggle): after uploading a file, also requests a public sharing URL for it and stores it against the asset (surfaced in the DAM/portal). Adds one extra API call per file.
- **Flat export** (global pipeline toggle): ignores subfolder structure and dumps every file directly into the destination's remote folder.
- Dropbox uploads skip files that already exist at the remote path (checked via `files/get_metadata`) — OneDrive and Google Drive always overwrite.
- Local, Dropbox, OneDrive, and Google Drive can all be active at once — a single pipeline run can push the same asset set to all four.

---

## Local

No auth. Type **Local**, then **Browse…** to pick a destination folder on disk. Files are copied directly with `fs`.

---

## Dropbox

**1. Create the app** at [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps):

1. Create app → choose **Scoped access** and either "App folder" or "Full Dropbox" access, depending on where you want files to land.
2. On the **Permissions** tab, enable: `account_info.read`, `files.content.write`, `files.metadata.read`, `sharing.read`, `sharing.write`. Submit.
3. On the **Settings** tab, copy the **App key** — this is the "Dropbox App Key" field in DC Hub.
4. Under **OAuth 2** → **Redirect URIs**, add:
   ```
   http://localhost:7623/callback
   ```

**2. Connect in DC Hub:**

1. Settings → Cloud Destinations → **Add destination**.
2. Type: **Dropbox**. Paste the App key.
3. Remote folder, e.g. `/DC Hub/ClientName/Exports`.
4. Click **Connect** — opens your browser to Dropbox's OAuth consent screen (PKCE flow, no client secret needed). Approve, and the browser redirects to `localhost:7623`, which the app is listening on; the token is captured automatically.
5. Tokens auto-refresh; a manual **Refresh** button is also available if a token shows as expired.

Uploads and the existence/sharing-link checks run through a native Rust command (`upload_to_dropbox`), not the webview — this avoids WKWebView body-size limits on large files.

---

## OneDrive

**1. Register the app** in [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**:

1. **Supported account types** — pick based on who needs to connect:
   - *Personal Microsoft accounts only*, or a multi-tenant option → in DC Hub, leave the **Azure Tenant ID** field as `common`.
   - *Accounts in this organizational directory only* (single tenant) → this is the common case for a company OneDrive/SharePoint. You'll need the **Directory (tenant) ID** from the app's Overview page — enter that exact GUID into DC Hub's **Azure Tenant ID** field. Single-tenant apps reject the generic `/common` endpoint with `AADSTS50059`.
2. **Authentication** blade → **Advanced settings** → turn **Allow public client flows** to **Yes**. Required for the device-code flow.
3. **API permissions** → add Microsoft Graph **delegated** permissions: `Files.ReadWrite`, `offline_access`, `User.Read`. Grant admin consent if your tenant requires it.
4. Copy the **Application (client) ID** from the Overview page (and the Directory/tenant ID, if single-tenant).

**2. Connect in DC Hub:**

1. Settings → Cloud Destinations → **Add destination**.
2. Type: **OneDrive**. Paste the Client ID, and the Tenant ID (or leave `common`).
3. Remote folder, e.g. `/DC Hub/ClientName/Exports`.
4. Click **Connect** — this is a **device code** flow, not a browser redirect: the app shows a code and a URL (`microsoft.com/devicelogin`). Open that URL on any device, sign in, and enter the code. DC Hub polls in the background until authorization completes.

Known gotchas:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `TypeError: Load failed` immediately on Connect | Microsoft's device-code endpoints don't send CORS headers for the app's `tauri://localhost` origin — the webview blocks the request before it reaches Microsoft | Already fixed — device-code requests run through native Rust (`reqwest`), not the webview |
| `AADSTS50059: No tenant-identifying information...` | App is single-tenant but DC Hub used the generic `/common` endpoint | Enter the app's Directory (tenant) ID into the **Azure Tenant ID** field |
| Error code `53003`, "Device state: Unregistered" during sign-in | Tenant's **Conditional Access** policy requires a registered/compliant device | Needs an Azure AD admin — exclude the app from that policy, enroll the device in Intune, or add an exception. Not fixable from the app. |

---

## Google Drive

**1. Set up the OAuth client** in [Google Cloud Console](https://console.cloud.google.com):

1. Create or select a project.
2. **APIs & Services → Library** → enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → configure it. Choose **Internal** if this is a Google Workspace org and only org members will connect; otherwise **External** and add each Google account that will connect as a **Test user** (while the app is unpublished/in Testing, only test users can complete sign-in).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Application type: **Web application** (DC Hub's flow uses a client secret). Add an **Authorized redirect URI**:
   ```
   http://localhost:7623/callback
   ```
5. Copy the **Client ID** and **Client Secret**.

**2. Multiple people connecting? Use a Shared Drive, not personal My Drive.**

If more than one person will click Connect (each with their own Google account), by default each person's uploads land in **their own personal "My Drive"** — not a shared location. To centralize everyone's pushes into one place:

1. In Google Drive, create a **Shared Drive** (left sidebar → **Shared drives** → **New**) that everyone who'll connect has at least Content Manager access to.
2. Open it and copy its ID from the URL: `drive.google.com/drive/folders/<SHARED_DRIVE_ID>` — the ID after `/folders/`.
3. Paste that into DC Hub's **Shared Drive ID** field (leave blank to use My Drive instead).

With a Shared Drive ID set, it doesn't matter whose account authorized the connection — uploads, folder creation, and sharing links all target that same Shared Drive.

**3. Connect in DC Hub:**

1. Settings → Cloud Destinations → **Add destination**.
2. Type: **Google Drive**. Paste the Client ID and Client Secret, and the Shared Drive ID if using one.
3. Remote folder, e.g. `DC Hub/ClientName/Exports` (no leading slash — folders are created automatically if they don't exist, inside the Shared Drive if one is set).
4. Click **Connect** — opens your browser to Google's consent screen. If the app is unpublished, you'll see an "unverified app" / "Google hasn't verified this app" warning — this is expected for an internal tool; click **Advanced → Go to [app name] (unsafe)** to proceed (only test users added in step 3 of the OAuth setup can do this successfully, unless the consent screen is set to **Internal**, in which case any account on your Workspace domain can). Approve, and the browser redirects to `localhost:7623` where the token is captured.

Uploads use the Drive v3 multipart endpoint, one API call per file; the destination folder path is resolved (and created if missing) lazily on first upload. Unlike Microsoft's device-code endpoints, Google's token endpoint does send permissive CORS headers, so this flow works directly via the webview's `fetch()` — no native Rust command needed here.

---

## Download links & CDN strategy

Two independent columns on the `assets` table feed asset downloads, for two different purposes:

| Column | Type | Source | Purpose |
| --- | --- | --- | --- |
| `download_url` | text | Cloudflare R2 (CDN) | The **primary download** — always the latest original file. This is what the web portal's Download button (`AssetDetail.tsx` → `webAssetActions.download`) actually uses today. |
| `download_urls` | jsonb array | Dropbox / OneDrive / Google Drive share links | Multiple provider links, for a **future** "download from Dropbox/OneDrive/Google Drive" picker — collected and stored now, no portal UI built yet. |

**Why two columns instead of one:** the CDN copy is fast, direct, and needs no auth — it's the right default for "click Download." The cloud-provider links exist for cases where someone specifically wants the file from a particular Dropbox/OneDrive/Drive location (e.g. a client who already has folder access there). Building the picker dialog for that is deferred; for now the data is just collected and stored so it's ready when needed.

**Only `client`-role destinations feed `download_urls`.** A destination's Role (Internal/Client, set in its form) controls this — internal-team links are never written to a column the client-facing portal can read from.

**Versioning — CDN keeps exactly one copy per asset, older versions don't accumulate.** Confirmed by the key scheme below: whichever identity a key is built from (stable identity or shortcode), it never encodes the version string, so a version bump overwrites the previous version's object rather than creating a new one.

Full version history isn't lost — it just isn't on the CDN. Whichever cloud destinations (Dropbox/OneDrive/Drive) still hold older versions keep them (nothing in this pipeline deletes from those), which is the intended hook for the "request an older version from a cloud destination" dialog mentioned above, once that's built.

**Toggle:** originals-to-CDN upload is its own pipeline step ("2  Upload originals to CDN" in the Tasks list), on by default, independent of the thumbnails step.

---

## CDN sync — identity and deduplication

Exactly how an asset maps to a CDN object, verified against the actual upload code (`r2.rs`, `pipelineService.ts`, `supabaseService.ts`) — not an approximation.

**Object keys — rename-proof for stable-identity clients, version-stable for everyone:**

| | Stable-identity clients (ESS, since the 2026-07-09 migration) | Legacy / unmigrated / orphan files |
| --- | --- | --- |
| Thumbnails | `thumbnails/<stable_id>/<child_id>.webp` | `thumbnails/<stem>-thumb.webp` (`stem` = full filename incl. version) |
| Originals | `originals/<stable_id>/<child_id><ext>` | `originals/<shortcode><ext>` (`shortcode` = filename with version stripped) |

`stable_id`/`child_id` come from the same folder-hash + `.dchub.json` manifest identity Supabase itself uses (`resolveChildId`, `supabaseService.ts:446-463`) — matched by content hash when a file's name doesn't match the manifest, which is exactly what makes it survive a file or folder rename. This identity is resolved once per pipeline run, in `resolveCdnIdentity()` (`supabaseService.ts`), **before** any CDN upload happens — early enough for the CDN steps to key by it — and reused as-is by the later Supabase sync step (see "Why this can't drift" below). A file with no resolvable stable identity (client not migrated, or the file sits outside any stable-identity-tagged package folder) falls back to exactly the pre-migration filename/shortcode-based key, unchanged.

**Deduplication — by content hash, not by existence or filename.** `upload_to_r2` (`r2.rs`) computes the file's sha256 before every upload, stores it as the object's `x-amz-meta-sha256` R2 metadata, and — before uploading — reads back whatever hash is already stored at that key via a HEAD request. If they match, the upload is skipped entirely (`skipped: true`, no PUT). If they differ, or the object doesn't have this metadata yet (anything uploaded before this mechanism existed), it uploads and overwrites. This is deliberately a *content* check, not an *existence* check: since object keys are version-stable, an existence-only check would see the previous version's object already at that key and skip uploading the new version's actual bytes — silently serving stale content. Checking the hash instead means:
- An unchanged re-run (same bytes, same key) is always skipped — no wasted uploads.
- A real version bump, or any genuine content edit under an unchanged version number, is always uploaded — the hash differs regardless of the key being stable.
- The very first upload after this shipped re-uploads once per object (no stored hash yet to compare against) — expected, one-time, not a bug.

A small per-asset safety-net cleanup runs after each original upload (`runOriginalUpload`, `pipelineService.ts`): it lists any sibling object under the same key prefix and deletes ones that don't match the just-uploaded key, covering the rare case where a version bump (or, under stable identity, any content change) also changes the file's extension.

**Local fast-path cache — skips hashing and the network entirely for files that haven't changed.** The content-hash check above is correct, but it still costs a full file read + sha256 computation + a network HEAD request for *every* file, on *every* run — real overhead at scale, especially for large originals. A local cache (`r2-upload-cache.json`, app-data dir; `pipelineService.ts`) records each uploaded object's local file `mtime`/`size` alongside its sha256. Before doing any of that work, both CDN steps do one cheap local `stat()` (no file read) and compare against the cache — if `mtime` and `size` both match what was recorded at the last successful upload, the file is skipped immediately (logged as `cached` in the summary line), with no hashing and no network call at all. This is purely a fast-path layered on top of the correctness check, not a replacement for it: a cache miss (new file, changed mtime/size, or an empty/fresh cache) always falls through to the full content-hash check, which remains the actual authority on whether the object needs updating. The only failure mode is a *stale* cache entry (e.g., someone deletes the object directly from the R2 bucket without touching the local file) causing an unnecessary skip until the local file's mtime or size next changes — never an *incorrect* one, since nothing here ever claims a file is uploaded without having gone through the real check at least once.

**Reading the log — four distinct outcomes, not one "✓ means uploaded."** Both `runCdnUpload` and `runOriginalUpload` now log:
- Green `✓` — a real upload happened (new content, or first time seeing this key).
- Dim `↷ cached, skipped` — local mtime/size matched the last upload; nothing was hashed or sent over the network.
- Dim `↷ unchanged, skipped` — the fast-path cache missed (or was empty), but the content-hash check against R2 found identical bytes already there.
- Red `✕` — a real error.

The `CDN DONE` summary line reports all of them separately (`N uploaded · M cached · K unchanged · ...`). Don't read a wall of green "✓" lines as proof of re-uploading — and don't confuse this section with **"THUMBNAILS"** earlier in the log, which is a *different* step (creating local `-thumb.webp` sidecar files) with its own green-means-"didn't exist locally yet" semantics.

**Why the CDN steps and the Supabase sync step can't disagree on identity.** `resolveCdnIdentity()` writes its resolved `child_id` assignments back to each package's `.dchub.json` manifest on disk immediately. The Supabase sync step (`exportAssetsToSupabase`) runs its own identity resolution afterward, completely unchanged from before — but by then the manifest already has the filename recorded, so its lookup hits the fast `byName` path (`supabaseService.ts:452-453`) instead of re-hashing. Both passes read the same file, so they're guaranteed to agree — not because the logic was duplicated carefully, but because the second pass is reading back what the first pass already wrote.

**One-time transition cost for already-existing stable-identity assets.** The first pipeline run after this shipped, every previously-uploaded asset's CDN key changes — from the old filename/shortcode-based scheme to the new `stable_id`/`child_id`-based one. This isn't a bug; it's the same "a rename orphans the old object" behavior described above, just happening once for the whole already-migrated asset set instead of gradually over time as individual files get renamed. The old objects become unreferenced (Supabase's `download_url`/`thumbnail_url` move to the new key on the next sync); nothing deletes the old ones automatically.

**`reconcileCdn`** (`pipelineService.ts`) — a full-bucket-listing cleanup pass that deletes anything not matching the currently expected key set — is implemented and kept in sync with this same key scheme, but **is not wired to any UI action today**. It exists for future use (e.g. cleaning up the one-time transition's orphaned old-scheme objects) but nothing currently calls it.

---

## Token expiry — one gotcha across all three providers

The status badge shows **"Expires soon"** once a token is within 1 hour of expiring ([client.ts:128](src/domain/client.ts#L128)). Google's tokens last exactly 1 hour, so this label can appear *immediately* after connecting — that's cosmetic, not an error. The real thing to know: **the pipeline does not auto-refresh tokens before uploading.** If a token has actually expired by the time you run an export, uploads to that destination will fail with an auth error. Click **Refresh token** in Settings before a big export run if a destination shows "Expires soon" or "Expired".

---

## Field reference

| Field | Local | Dropbox | OneDrive | Google Drive |
| --- | --- | --- | --- | --- |
| Client ID / App key | — | ✅ | ✅ | ✅ |
| Client Secret | — | — | — | ✅ |
| Tenant ID | — | — | ✅ (default `common`) | — |
| Shared Drive ID | — | — | — | ✅ (blank = My Drive) |
| Remote folder | Local path (Browse…) | Dropbox path | Graph path | Drive folder path |
| Auth flow | none | OAuth PKCE (browser redirect) | Device code (separate device/browser) | OAuth (browser redirect, with client secret) |
