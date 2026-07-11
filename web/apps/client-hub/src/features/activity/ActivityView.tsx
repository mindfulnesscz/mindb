export default function ActivityView() {
  return (
    <div className="max-w-[760px] mx-auto px-5 py-8">
      <h1 className="font-serif text-2xl font-medium text-cosmos-black mb-6">Activity</h1>
      <p className="font-sans text-sm text-text-muted">
        What moved on the work relevant to you — newest first.
      </p>
      <div className="mt-8 space-y-0">
        {[
          { actor: 'Jana K.', action: 'approved', asset: 'Sealing — pitch deck', time: '2 hours ago' },
          { actor: 'Petr Mucha', action: 'uploaded', asset: 'Brand film — cut 03', time: '1 day ago' },
          { actor: 'Jana K.', action: 'requested changes on', asset: 'Spring campaign — hero', time: '2 days ago' },
        ].map((item, i) => (
          <div key={i} className="flex items-start gap-4 py-4 border-b border-hairline">
            <div className="w-8 h-8 rounded-[28%_38%] bg-gray-150 shrink-0" />
            <div className="text-sm font-sans text-cosmos-black">
              <span className="font-semibold">{item.actor}</span>
              {' '}{item.action}{' '}
              <span className="font-semibold">{item.asset}</span>
            </div>
            <span className="ml-auto text-[11px] font-sans text-text-muted whitespace-nowrap">{item.time}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
