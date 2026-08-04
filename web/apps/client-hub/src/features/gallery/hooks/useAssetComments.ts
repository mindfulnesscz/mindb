/* The comment thread for one asset.
 *
 * Reading and writing are different permissions: members may READ the thread (`canReadComments`)
 * but only staff may post — enforced by RLS, mirrored here. When Supabase is not configured the
 * hook falls back to MOCK_COMMENTS so the portal is demoable without a backend.
 */

import { useEffect, useRef, useState } from 'react'
import { canReadComments, MOCK_COMMENTS, type Role } from '@sotto/asset-library'
import { fetchComments, addComment, deleteComment, type RealComment } from '../../../services/commentService'
import { reportError } from '../../../lib/reportError'
import { isConfigured } from '../../../lib/supabase'

export function useAssetComments(assetId: string, userId: string | null, role: Role) {
  const [comments, setComments] = useState<RealComment[]>([])
  const [commentInput, setCommentInput] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentThanks, setCommentThanks] = useState(false)
  const thanksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!canReadComments(role)) return
    if (isConfigured()) {
      fetchComments(assetId).then(setComments)
        .catch(e => reportError('feedback.AssetDetail.fetchComments', e))
    } else {
      const mock = MOCK_COMMENTS.filter(c => c.assetId === assetId)
      setComments(mock.map(c => ({
        id: c.id,
        assetId: c.assetId,
        userId: '',
        authorName: c.author,
        authorInitials: c.author.split(' ').map(w => w[0]).join('').slice(0, 2),
        authorRole: c.role,
        body: c.body,
        createdAt: c.createdAt,
      })))
    }
  }, [assetId, role])

  // The "thanks" flash outlives its own render, so it must be cancelled on unmount.
  useEffect(() => () => {
    if (thanksTimerRef.current) clearTimeout(thanksTimerRef.current)
  }, [])

  async function submitComment() {
    const body = commentInput.trim()
    if (!body || !userId || commentBusy) return
    setCommentBusy(true)
    try {
      const newComment = await addComment(assetId, userId, body)
      setComments(prev => [...prev, newComment])
      setCommentInput('')
      setCommentThanks(true)
      if (thanksTimerRef.current) clearTimeout(thanksTimerRef.current)
      thanksTimerRef.current = setTimeout(() => setCommentThanks(false), 3000)
    } catch (err) {
      reportError('feedback.AssetDetail.addComment', err)
    } finally {
      setCommentBusy(false)
    }
  }

  async function removeComment(id: string) {
    try {
      await deleteComment(id)
      setComments(prev => prev.filter(c => c.id !== id))
    } catch (err) {
      reportError('feedback.AssetDetail.deleteComment', err)
    }
  }

  function onCommentKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitComment()
    }
  }

  return {
    comments, commentInput, setCommentInput, commentBusy, commentThanks,
    submitComment, removeComment, onCommentKeyDown,
  }
}
