import { useParams, Link } from 'react-router-dom'
import { MOCK_ASSETS } from '@dc-hub/asset-library'
import AssetDetail from './AssetDetail'

export default function AssetDetailPage() {
  const { id } = useParams<{ id: string }>()
  const asset = MOCK_ASSETS.find(a => a.id === id)

  if (!asset) {
    return (
      <div className="flex items-center justify-center h-screen font-sans text-text-muted">
        <div className="text-center">
          <p className="text-sm mb-3">Asset not found.</p>
          <Link to="/" className="text-sm underline text-cosmos-black">Back to gallery</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg">
      <div className="border-b border-border px-6 py-3 flex items-center gap-3">
        <div className="w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
          <span className="text-clear-white text-[10px] font-bold font-sans leading-none">C</span>
        </div>
        <span className="text-xs font-sans font-bold uppercase tracking-label text-cosmos-black">DC HUB</span>
        <span className="text-border">·</span>
        <Link to="/" className="text-xs font-sans text-text-muted hover:text-cosmos-black transition-colors">
          Back to gallery
        </Link>
      </div>
      <AssetDetail asset={asset} mount="page" />
    </div>
  )
}
