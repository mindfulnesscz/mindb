/* `/share/:id` — one asset, no client chrome.
 *
 * This route was documented as working and was in fact a stub over `MOCK_ASSETS`, so in production it
 * always rendered "Asset not found". It reads the database now.
 *
 * RLS DOES THE DECIDING, and there is nothing here to enforce. `effective_level = 'public'` is the only
 * level an anonymous visitor can match; everything else needs a session, and `client`/`internal` need
 * the right one. A client-side check would not be a perimeter, so this component asks for the row and
 * renders one of four states depending on what came back — it never reasons about whether the viewer
 * *should* have got it.
 *
 * "No such asset" and "not yours" are the same answer from the database, deliberately. What differs
 * here is only whether there is a session to blame: with none, the useful thing to say is "sign in";
 * with one, the honest thing is "you don't have access". Neither confirms the asset exists.
 *
 * NO EXTRA VIEW EVENTS. `asset_events` is capped at 120 per asset per minute and this surface is
 * public — the cap exists because of exactly this route (REFACTOR_PLAN.md §:1029-1050). Whatever
 * `AssetDetail` already fires on mount is the budget.
 */

import { useState, type ReactNode } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { MOCK_ASSETS } from '@dc-hub/asset-library'
import { useAuth } from '../../context/AuthContext'
import { useRole } from '../../context/RoleContext'
import { fetchAsset } from '../../services/assetService'
import { isConfigured } from '../../lib/supabase'
import SignInModal from '../auth/SignInModal'
import AssetDetail from './AssetDetail'

function Chrome({ children, backTo }: { children: ReactNode; backTo?: string }) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="border-b border-border px-6 py-3 flex items-center gap-3">
        <div className="w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
          <span className="text-clear-white text-[10px] font-bold font-sans leading-none">C</span>
        </div>
        <span className="text-xs font-sans font-bold uppercase tracking-label text-cosmos-black">DC HUB</span>
        {/* Only rendered when there is somewhere the viewer can actually go. Both back links here used
            to be an unconditional `Link to="/"`, which sends a client to the staff admin landing. */}
        {backTo && (
          <>
            <span className="text-border">·</span>
            <Link
              to={backTo}
              className="text-xs font-sans text-text-muted hover:text-cosmos-black transition-colors"
            >
              Back to gallery
            </Link>
          </>
        )}
      </div>
      {children}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="max-w-xl mx-auto py-10 px-5 space-y-4 animate-pulse" aria-busy="true">
      <div className="aspect-square bg-gray-150 rounded-sm" />
      <div className="h-5 bg-gray-150 rounded-chip w-2/3" />
      <div className="h-3 bg-gray-150 rounded-chip w-1/3" />
      <div className="h-3 bg-gray-150 rounded-chip w-1/2" />
    </div>
  )
}

export default function AssetDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { session } = useAuth()
  const { activeClient } = useRole()
  const [showSignIn, setShowSignIn] = useState(false)

  /* The signed-in viewer's own portal, as a slug. Taken from RoleContext, which already resolves the
     client row behind `profile.client_id`. Resolving a slug from `asset.clientId` for an ANONYMOUS
     viewer would need a new RPC, and widening an unauthenticated surface to put a link in a header is
     not a trade worth making — so an anonymous visitor gets no back link, and the sign-in call to
     action instead. */
  const backTo = activeClient?.slug ? `/${activeClient.slug}` : undefined

  const query = useQuery({
    queryKey: ['asset', id],
    enabled: !!id,
    queryFn: async () => {
      // Demo mode keeps working end to end: the mock library is the only thing there is to read.
      if (!isConfigured()) return MOCK_ASSETS.find(a => a.id === id) ?? null
      return await fetchAsset(id!)
    },
  })

  if (query.isPending) {
    return <Chrome backTo={backTo}><Skeleton /></Chrome>
  }

  if (query.data) {
    /* No `onDetailStateChange`: this route has nowhere to write the focused sibling and the lightbox
       to, so AssetDetail keeps them locally. See useDetailFocus. */
    return <Chrome backTo={backTo}><AssetDetail asset={query.data} mount="page" /></Chrome>
  }

  // Nothing came back — no such asset, or not this viewer's. The database gives one answer for both.
  return (
    <Chrome backTo={backTo}>
      <div className="max-w-md mx-auto py-20 px-5 text-center">
        {session ? (
          <>
            <p className="font-serif text-xl font-medium text-cosmos-black mb-2">
              You don't have access to this asset.
            </p>
            <p className="font-sans text-sm text-text-muted">
              It may have been removed, or shared with a different account than the one you're signed
              in with.
            </p>
          </>
        ) : (
          <>
            <p className="font-serif text-xl font-medium text-cosmos-black mb-2">
              Sign in to view this asset.
            </p>
            <p className="font-sans text-sm text-text-muted mb-8">
              This link is only visible to the people it was shared with.
            </p>
            <button
              onClick={() => setShowSignIn(true)}
              className="px-8 py-3 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm hover:bg-ink-800 transition-colors"
              style={{ boxShadow: '4px 4px 0 #161616' }}
            >
              Sign in / Request access
            </button>
          </>
        )}
      </div>

      {showSignIn && (
        // Back to this exact asset once the round trip completes.
        <SignInModal redirectTo={window.location.href} onClose={() => setShowSignIn(false)} />
      )}
    </Chrome>
  )
}
