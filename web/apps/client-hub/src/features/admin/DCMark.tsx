/* The DC logo mark. */



export function DCMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const dim = size === 'lg' ? 'w-16 h-16' : 'w-7 h-7'
  const text = size === 'lg' ? 'text-2xl' : 'text-xs'
  return (
    <div className={`${dim} rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0`}
      style={size === 'lg' ? { boxShadow: '6px 6px 0 #161616' } : undefined}>
      <span className={`text-clear-white ${text} font-bold font-sans leading-none`}>C</span>
    </div>
  )
}

// ── Domain whitelist tag input ────────────────────────────────

