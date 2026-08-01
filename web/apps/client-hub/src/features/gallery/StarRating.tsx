/* Star rating control — presentational and controlled.
 *
 * `onChange` optional is the read-only mode: guests and clients see the score, staff can set it.
 * One vote per person per asset is enforced by the database (unique on asset_id + user_id), not here.
 */

import { useState, useEffect } from 'react'

export function StarRating({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  const [hovered, setHovered] = useState(0)
  const [selected, setSelected] = useState(value)
  // Sync when parent value changes (initial DB load)
  useEffect(() => { setSelected(value) }, [value])

  const display = hovered || selected
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onClick={() => { setSelected(n); onChange?.(n) }}
          onMouseEnter={() => onChange && setHovered(n)}
          onMouseLeave={() => onChange && setHovered(0)}
          className={`text-xl leading-none transition-colors ${
            n <= display ? 'text-cosmos-black' : 'text-gray-300'
          } ${onChange ? 'cursor-pointer' : 'cursor-default'}`}
          aria-label={`Rate ${n} star${n > 1 ? 's' : ''}`}
        >
          ★
        </button>
      ))}
    </div>
  )
}
