import { describe, it, expect } from 'vitest';
import { isVideoFile, VIDEO_EXTS } from './video';

describe('isVideoFile', () => {
  it('accepts the formats Stream ingests', () => {
    for (const ext of ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']) {
      expect(isVideoFile(`clip${ext}`), ext).toBe(true);
    }
  });

  it('is case-insensitive — cameras and phones write uppercase extensions', () => {
    expect(isVideoFile('DJI_0001.MP4')).toBe(true);
    expect(isVideoFile('IMG_1234.MOV')).toBe(true);
  });

  it('reads the extension off a full object key, not just a filename', () => {
    expect(isVideoFile('client/9f2a-.../Brand Film v2.mp4')).toBe(true);
    expect(isVideoFile('internal/uuid/thumbnails/stable/child.webp')).toBe(false);
  });

  /* A gated video whose master is a .psd would be presigned and pulled before Stream rejected it.
     The point of the check is to refuse before spending that. */
  it('rejects images and documents', () => {
    for (const name of ['shot.jpg', 'deck.pdf', 'art.psd', 'logo.svg', 'sheet.xlsx']) {
      expect(isVideoFile(name), name).toBe(false);
    }
  });

  /* GIF is video-shaped, Stream will not take it, and the product already treats it as an image.
     Sending one would fail after the master had been pulled. */
  it('rejects .gif specifically', () => {
    expect(isVideoFile('loop.gif')).toBe(false);
    expect(VIDEO_EXTS.has('.gif')).toBe(false);
  });

  it('rejects names with no extension and dotfiles', () => {
    expect(isVideoFile('README')).toBe(false);
    expect(isVideoFile('.mp4')).toBe(false);      // a dotfile named .mp4, not a video
    expect(isVideoFile('folder.mp4/notes.txt')).toBe(false);
  });
});
