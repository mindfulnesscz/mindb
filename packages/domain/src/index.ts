/* @sotto/domain — the asset domain, shared by the desktop app and the web portal.
 *
 * Everything here is PLATFORM-FREE by contract: no Tauri, no Supabase, no React, no
 * filesystem, no network, no `window`. Pure functions and types over strings and plain
 * objects. That is what lets the same rules run inside the desktop pipeline, inside the
 * portal, and (in future) inside a Node script or an edge function without a shim.
 *
 * If a module here ever needs to read a file or call an API, it belongs in the app that
 * owns that capability — pass the data in instead.
 *
 * What lives here and why it must be shared:
 * - `stableId`      — folder-based identity. The permanent match key between a folder on
 *                     someone's disk, a row in Postgres and an object on the CDN. If the two
 *                     apps ever disagree on this regex, published assets orphan.
 * - `naming`        — which folders are packages / OUT, and what the run skips.
 * - `artifactLayout` — where render artifacts live. One `thumbnails/` folder beside the files it
 *                     serves; the desktop writes there, every walker excludes it by location.
 * - `version`       — version parsing and "highest version wins". Decides what ships.
 * - `vocabulary`    — the three-dimension taxonomy and the shortcode string it renders.
 * - `filenameTranslator` — shortcodes ⇄ human labels. The portal shows what the pipeline wrote.
 * - `assetGrouping` — OUT paths → single assets vs gallery groups.
 * - `video`         — which extensions are video, and therefore go to Cloudflare Stream.
 * - `streamUrls`    — every Cloudflare Stream delivery URL, signed or not.
 * - `callerAuth`    — what a backend says when it refuses a session token. Three backends answer
 *                     this and one portal acts on the answer; a drifted copy fails silently.
 */

export * from './stableId';
export * from './naming';
export * from './artifactLayout';
export * from './version';
export * from './vocabulary';
export * from './filenameTranslator';
export * from './assetGrouping';
export * from './assetStorage';
export * from './callerAuth';
export * from './cdnGarbageCollection';
export * from './video';
export * from './streamUrls';
