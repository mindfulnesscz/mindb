/* Canvas geometry.
 *
 * Obsidian Canvas positions nodes in absolute pixels, so these are the grid. MAX_ROWS_PER_COL caps
 * a column and overflows into new ones — without it a client with 300 assets gets a single unusable
 * 160,000-pixel-tall column.
 */



export const CANVAS_W       = 480;
export const CANVAS_H       = 540;
export const CANVAS_GAP     = 40;
export const CELL_W         = CANVAS_W + CANVAS_GAP;
export const CELL_H         = CANVAS_H + CANVAS_GAP;
export const BASE_H_GAP     = 150;
export const DEFAULT_COLS   = 3;
export const MAX_ROWS_PER_COL = 20; // cap column height — overflow to additional columns
export const LABEL_H        = 60;  // cluster label node height
export const LABEL_GAP      = 16;  // gap between label bottom and first note top
export const NOTE_Y_OFFSET  = LABEL_H + LABEL_GAP; // all notes shifted down by this amount
