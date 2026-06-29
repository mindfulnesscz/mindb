import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import css from './AccordionGroup.module.css';

interface Props {
  label:   string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function AccordionGroup({ label, summary, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={css.group}>
      <button className={css.header} onClick={() => setOpen(o => !o)}>
        <ChevronRight
          size={14}
          className={`${css.caret}${open ? ` ${css.caretOpen}` : ''}`}
        />
        <span className={css.label}>{label}</span>
        {summary && <span className={css.summary}>{summary}</span>}
      </button>
      {open && <div className={css.body}>{children}</div>}
    </div>
  );
}
