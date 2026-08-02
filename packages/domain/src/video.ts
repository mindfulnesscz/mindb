/* Which files are video.
 *
 * Shared because three places need the same answer and would otherwise each guess: the desktop
 * pipeline decides what to hand to Stream, the stream-upload function refuses anything that is not
 * video before spending an API call on it, and the portal decides whether to render a player or an
 * image. Three copies of a list of extensions is three chances for `.m4v` to be video in one place
 * and not another, which shows up as a file that uploads and never plays.
 */

/* Cloudflare Stream's documented input formats. Kept to what Stream actually accepts rather than
 * every container that exists: an extension in this set is a promise that an upload will succeed,
 * and a format Stream rejects would fail after the master had already been presigned and pulled.
 *
 * Notably absent: `.gif`. It is video-shaped and Stream will not take it, and it is already handled
 * as an image everywhere in the product. */
export const VIDEO_EXTS: ReadonlySet<string> = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.flv', '.ts', '.mts', '.m2ts',
  '.mxf', '.lxf', '.gxf', '.3gp', '.webm', '.mpg', '.mpeg', '.m4v',
]);

/** True when `name` looks like a video this product can put on Stream. Case-insensitive; accepts a
 *  bare filename, a path, or a full object key. */
export function isVideoFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 && VIDEO_EXTS.has(base.slice(dot).toLowerCase());
}
