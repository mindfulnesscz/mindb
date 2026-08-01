/* The comment thread and composer.
 *
 * Reading and writing are DIFFERENT permissions: members may read the thread, only staff may post.
 * Both are enforced by RLS — this mirrors them so the UI never offers an action the server will
 * refuse. The caller decides whether to render this at all (`canReadComments`); the composer gates
 * itself on `canComment`.
 */

import { canComment, type Role } from '@dc-hub/asset-library'
import type { RealComment } from '../../../services/commentService'

export interface AssetCommentsPanelProps {
  role: Role
  userId: string | null
  isStaff: boolean
  comments: RealComment[]
  commentInput: string
  setCommentInput: (v: string) => void
  commentBusy: boolean
  commentThanks: boolean
  onSubmit: () => void
  onDelete: (id: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

export function AssetCommentsPanel({
  role, userId, isStaff, comments, commentInput, setCommentInput,
  commentBusy, commentThanks,
  onSubmit: handleSubmitComment,
  onDelete: handleDeleteComment,
  onKeyDown: handleCommentKeyDown,
}: AssetCommentsPanelProps) {
  return (
          <div>
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-3">
              Comments · {comments.length}
            </p>
            <div className="space-y-4">
              {comments.map(c => (
                <div key={c.id} className="flex gap-3">
                  <div className="w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0">
                    <span className="text-clear-white text-[9px] font-bold font-sans">
                      {c.authorInitials}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-sans font-semibold text-cosmos-black">{c.authorName}</span>
                      <span className="text-[9px] font-sans font-bold uppercase tracking-label border border-border px-1.5 py-0.5 rounded-chip text-text-muted">
                        {c.authorRole}
                      </span>
                      {isStaff && (
                        <button
                          onClick={() => handleDeleteComment(c.id)}
                          className="ml-auto text-text-muted hover:text-cosmos-black transition-colors text-base leading-none"
                          aria-label="Delete comment"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <p className="text-sm font-sans text-cosmos-black leading-snug">{c.body}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Comment composer — staff only */}
            {canComment(role) && (
              <div className="mt-4 space-y-2">
                {commentThanks && (
                  <p className="text-[11px] font-sans text-text-muted transition-opacity">
                    Thank you for your comment!
                  </p>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={commentInput}
                    onChange={e => setCommentInput(e.target.value)}
                    onKeyDown={handleCommentKeyDown}
                    placeholder="Add a comment…"
                    disabled={commentBusy || !userId}
                    className="flex-1 text-sm font-sans border border-border rounded-sm px-3 py-2 placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50"
                  />
                  <button
                    onClick={handleSubmitComment}
                    disabled={commentBusy || !commentInput.trim() || !userId}
                    className="px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm hover:bg-ink-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {commentBusy ? '…' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </div>
  )
}
