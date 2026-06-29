import { Layers, BookOpen, Sparkles, Settings } from 'lucide-react';
import { useAppStore, type NavDest } from '../store/appStore';
import css from './NavRail.module.css';

const ITEMS: { dest: NavDest; icon: React.FC<{ size?: number }>; label: string }[] = [
  { dest: 'pipeline',   icon: Layers,    label: 'Pipeline' },
  { dest: 'vocabulary', icon: BookOpen,  label: 'Vocab' },
  { dest: 'generator',  icon: Sparkles,  label: 'Generate' },
  { dest: 'settings',   icon: Settings,  label: 'Settings' },
];

export function NavRail() {
  const { active, navigate } = useAppStore();

  return (
    <aside className={css.rail}>
      <div className={css.brand}>
        {/* DC open-superellipse brand mark */}
        <svg className={css.brandSymbol} viewBox="0 0 32 32" fill="none">
          <path
            d="M16 2C8.268 2 2 8.268 2 16s6.268 14 14 14 14-6.268 14-14S23.732 2 16 2z
               M16 6c5.523 0 10 4.477 10 10s-4.477 10-10 10S6 21.523 6 16 10.477 6 16 6z"
            fill="currentColor"
            fillRule="evenodd"
          />
        </svg>
      </div>

      <nav className={css.nav}>
        {ITEMS.map(({ dest, icon: Icon, label }) => (
          <button
            key={dest}
            className={`${css.navItem}${active === dest ? ` ${css.active}` : ''}`}
            onClick={() => navigate(dest)}
            title={label}
          >
            <Icon size={20} />
            <span className={css.navLabel}>{label}</span>
          </button>
        ))}
      </nav>

      <div className={css.avatar} title="DC">DC</div>
    </aside>
  );
}
