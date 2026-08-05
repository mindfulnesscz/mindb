# Cloud Destinations

How the pipeline publishes exported assets to Local, Dropbox, OneDrive, and Google Drive, and how to connect each one.

## Where configuration lives

| Piece | Edit where | Notes |
| --- | --- | --- |
| Destination structure (name, type, remote path, `role`, `minRole`, generate link, portal visibility, Reveal flag) | **Web portal** → Admin → client → **Export destinations** | Stored in `clients.cloud_destinations`; tokens always stripped |
| OAuth connect / refresh / Google client secret / local folder path on this machine | **Desktop** → Settings → Cloud destinations | Pull with **Sync**, then Connect |
| Which destinations run on this pipeline pass | Desktop Pipeline checkboxes | Local preference — not pushed back to the portal |

Full product workflow (tags + destinations): [docs Tags & export destinations](../docs/pages/getting-started/tags-and-destinations.mdx).

Older docs that said “Add destination” in desktop Settings are obsolete for structure — add destinations in the portal first.

---

## How publishing works

- Each destination has: **Identity** (name, pipeline role — `internal` or `client`), portal **`minRole`**, **Type**, **Credentials** (desktop), **Remote folder**, and **Export options**.
- **Every asset is its own push.** When a pipeline run finishes collecting assets, the app loops over every selected (connected, token present) cloud destination and uploads **every asset individually** — one upload API call per file per destination, at concurrency 2. There is no zip/batch upload.
- **Generate link** (per destination toggle): after uploading a file, also requests a public sharing URL for it and stores it against the asset. Adds one extra API call per file.
- **Flat export** (global pipeline toggle / dest flag): ignores subfolder structure and dumps every file directly into the destination's remote folder.
- Dropbox uploads skip files that already exist at the remote path (checked via `files/get_metadata`).
- Google Drive skips when a same-name file already exists with the same size; changed files are updated in place (no duplicates). OneDrive still overwrites the same path on every run.
- Across all cloud providers, a local **mtime+size cache** (`cloud-upload-cache.json`) skips unchanged files with no file read and no provider API — same idea as the CDN R2 cache. First successful upload/skip seeds the cache; later runs only hit the network for new or changed files.
- Local, Dropbox, OneDrive, and Google Drive can all be active at once — a single pipeline run can push the same asset set to all four.

---

## Local

No auth. Portal defines the destination; on desktop open it and **Browse…** to pick the folder on this machine (machine path can override a portal template).

---

## Dropbox

**1. Create the app** at [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps):

1. Create app → choose **Scoped access** and either "App folder" or "Full Dropbox" access, depending on where you want files to land.
2. On the **Permissions** tab, enable: `account_info.read`, `files.content.write`, `files.metadata.read`, `sharing.read`, `sharing.write`. Submit.
3. On the **Settings** tab, copy the **App key** — paste into the portal destination (and/or desktop credentials field).
4. Under **OAuth 2** → **Redirect URIs**, add:
   ```
   http://localhost:7623/callback
   ```

**2. Connect in DC Hub:**

1. Portal: add a Dropbox destination (remote path, role, minRole, generate link).
2. Desktop: Settings → Cloud Destinations → **Sync** → open the destination → paste App key if needed → **Connect**.
3. Tokens auto-refresh; a manual **Refresh** button is also available if a token shows as expired.

Uploads and the existence/sharing-link checks run through a native Rust command (`upload_to_dropbox`), not the webview — this avoids WKWebView body-size limits on large files.

---

## OneDrive

**1. Register the app** in [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**:

1. **Supported account types** — pick based on who needs to connect:
   - *Personal Microsoft accounts only*, or a multi-tenant option → in DC Hub, leave the **Azure Tenant ID** field as `common`.
   - *Accounts in this organizational directory only* (single tenant) → enter the Directory (tenant) ID into DC Hub's **Azure Tenant ID** field. Single-tenant apps reject the generic `/common` endpoint with `AADSTS50059`.
2. **Authentication** blade → **Advanced settings** → turn **Allow public client flows** to **Yes**. Required for the device-code flow.
3. **API permissions** → add Microsoft Graph **delegated** permissions: `Files.ReadWrite`, `offline_access`, `User.Read`. Grant admin consent if your tenant requires it.
4. Copy the **Application (client) ID** from the Overview page (and the Directory/tenant ID, if single-tenant).

**2. Connect in DC Hub:**

1. Portal: add OneDrive destination.
2. Desktop: Sync → open destination → Client ID + Tenant ID → **Connect** (device code flow).

Known gotchas:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `TypeError: Load failed` immediately on Connect | Microsoft's device-code endpoints don't send CORS headers for the app's `tauri://localhost` origin | Already fixed — device-code requests run through native Rust (`reqwest`) |
| `AADSTS50059: No tenant-identifying information...` | App is single-tenant but DC Hub used `/common` | Enter the app's Directory (tenant) ID |
| Error code `53003`, "Device state: Unregistered" during sign-in | Tenant Conditional Access | Needs an Azure AD admin — not fixable from the app |

---

## Google Drive

**1. Set up the OAuth client** in [Google Cloud Console](https://console.cloud.google.com):

1. Create or select a project.
2. **APIs & Services → Library** → enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → configure it.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Application type: **Web application**. Add authorised redirect URI:
   ```
   http://localhost:7623/callback
   ```
5. Copy the **Client ID** (portal + desktop) and **Client Secret** (**desktop only** — never store in portal).

**2. Multiple people connecting? Use a Shared Drive, not personal My Drive.**

Paste the Shared Drive ID into the portal destination so every teammate’s uploads land in one place.

**3. Connect in DC Hub:**

1. Portal: add Google Drive destination (client id, shared drive id, remote path).
2. Desktop: Sync → open destination → enter **Client Secret** → **Connect**.

---

## Download links & CDN strategy

Two independent columns on the `assets` table feed asset downloads:

| Column | Type | Source | Purpose |
| --- | --- | --- | --- |
| `download_url` | text | Cloudflare R2 (CDN) | The **primary download** — portal Download button |
| `download_urls` | jsonb array | Dropbox / OneDrive / Google Drive share links | Portal **Source links**, role-gated by destination `minRole` / `showInPortal` |

**Only `client`-role destinations feed `download_urls`.** Internal-team links never land in that column.

Entries preferably include `destId` (destination UUID) so the portal can match visibility rules when destination names change.

**Reveal in Finder** is separate: portal → `http://127.0.0.1:7624/reveal` with `clientId` + `stableId`; desktop walks `sourceFolder` for `.dchub.json`.

**Versioning — CDN keeps exactly one copy per asset.** Object keys do not encode the version string; a version bump overwrites. Full history can still exist on cloud destinations.

---

## CDN sync — identity and deduplication

Exactly how an asset maps to a CDN object — see the longer reference retained below for operators who need key schemes and skip semantics.

**Object keys — rename-proof for stable-identity clients, version-stable for everyone:**

| | Stable-identity clients | Legacy / unmigrated / orphan files |
| --- | --- | --- |
| Thumbnails | `thumbnails/<stable_id>/<child_id>.webp` | `thumbnails/<stem>-thumb.webp` |
| Originals | `originals/<stable_id>/<child_id><ext>` | `originals/<shortcode><ext>` |

**Deduplication — by content hash, not by existence or filename.** `upload_to_r2` stores `x-amz-meta-sha256` and skips when the hash matches.

**Local fast-path cache** (`r2-upload-cache.json`) skips hashing when mtime/size match the last successful upload.

Log outcomes: `✓` uploaded · `↷ cached` · `↷ unchanged` · `✕` error.

---

## Token expiry — one gotcha across all three providers

The status badge shows **"Expires soon"** once a token is within 1 hour of expiring. Google's tokens last exactly 1 hour, so this label can appear *immediately* after connecting — that's cosmetic. **The pipeline does not auto-refresh tokens before uploading.** Click **Refresh token** in Settings before a big export if a destination shows "Expires soon" or "Expired".

---

## Field reference

| Field | Local | Dropbox | OneDrive | Google Drive | Where set |
| --- | --- | --- | --- | --- | --- |
| Client ID / App key | — | ✅ | ✅ | ✅ | Portal (public) + desktop override |
| Client Secret | — | — | — | ✅ | **Desktop only** |
| Tenant ID | — | — | ✅ (default `common`) | — | Portal / desktop |
| Shared Drive ID | — | — | — | ✅ | Portal |
| Remote / local path | ✅ | ✅ | ✅ | ✅ | Portal structure; local path overridable on machine |
| `minRole` / `showInPortal` / `allowRevealLocal` | ✅ | ✅ | ✅ | ✅ | **Portal only** |
| Auth flow | none | OAuth PKCE | Device code | OAuth + secret | Desktop Connect |
