import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SearchableOption {
  id: string;
}

interface SearchableSelectProps<T extends SearchableOption> {
  items: T[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  className?: string;
  /** Runs over everything a row shows, so a half-remembered fragment finds it. */
  matches: (item: T, query: string) => boolean;
  renderOption: (item: T) => ReactNode;
  /** The box's own label; its placeholder is the same words with an ellipsis. */
  searchLabel: string;
  /** What the list says when there is nothing here to search. */
  emptyText: string;
  /** What it says when the query matches none of the rows it was given. */
  noMatchText: string;
}

/**
 * The shared body of the pickers — accounts, products, and whatever comes
 * next — so that one list carries the behaviours every one of them needs and
 * no two copies can drift.
 *
 * The behaviour that most needs to exist in exactly one place is the Enter
 * key: these pickers all sit inside forms that post money, so Enter in the
 * search box must pick the row under the cursor and *stop*, never reach the
 * form as a submit. Written once here, that guarantee holds for every picker
 * built on it; written twice, it is one edit away from being lost in one of
 * them.
 */
export default function SearchableSelect<T extends SearchableOption>({
  items,
  value,
  onChange,
  placeholder,
  className,
  matches,
  renderOption,
  searchLabel,
  emptyText,
  noMatchText,
}: SearchableSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = items.find((i) => i.id === value);

  const visible = items.filter((i) => matches(i, query));

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Typing is the first thing anyone does with a list this long, so the box
  // takes focus as the panel opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Reopening starts from the whole list. A query left behind would present a
  // narrowed list with nothing on screen explaining why it is narrowed.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter picks the only sensible row left on screen. Stopping it here also
    // keeps it from reaching the surrounding form as a submit — this picker
    // sits inside a form where an accidental submit would post a transaction.
    if (e.key === 'Enter') {
      e.preventDefault();
      if (visible.length > 0) choose(visible[0].id);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${className || 'input-field'} flex items-center justify-between text-left`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">
          {selected ? renderOption(selected) : <span className="text-gray-400">{placeholder}</span>}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-300 bg-white shadow-lg">
          {items.length > 0 && (
            <div className="border-b border-gray-100 p-2">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={`${searchLabel}…`}
                aria-label={searchLabel}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-primary-500 focus:outline-none"
              />
            </div>
          )}
          <ul role="listbox" className="max-h-60 overflow-y-auto py-1">
            {items.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-500">{emptyText}</li>
            ) : visible.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-500">{noMatchText}</li>
            ) : (
              visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => choose(item.id)}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-primary-50 ${item.id === value ? 'bg-primary-50' : ''}`}
                  >
                    {renderOption(item)}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
