import { useId, type ReactNode } from 'react';

export function TabButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border px-4 py-2 text-sm ${active ? 'border-amber-300/50 bg-amber-200/10 text-amber-100' : 'border-slate-700/70 bg-slate-950/40 text-slate-200'}`}
    >
      {children}
    </button>
  );
}

export function InfoMiniCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-3 text-sm">
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className="mt-1 text-slate-100">{value}</p>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  step,
  asTextArea = false,
  placeholder,
  suggestions
}: {
  label: string;
  value: string | number;
  onChange: (value: string | number) => void;
  type?: 'text' | 'number';
  step?: string;
  asTextArea?: boolean;
  placeholder?: string;
  suggestions?: readonly string[];
}): JSX.Element {
  const suggestionsId = useId();
  return (
    <label className="grid gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</span>
      {asTextArea ? (
        <textarea
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-20 rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
        />
      ) : (
        <>
          <input
            type={type}
            step={step}
            value={value}
            placeholder={placeholder}
            list={suggestions && suggestions.length > 0 ? suggestionsId : undefined}
            onChange={(event) => onChange(type === 'number' ? Number(event.target.value) : event.target.value)}
            className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
          />
          {suggestions && suggestions.length > 0 ? (
            <datalist id={suggestionsId}>
              {suggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          ) : null}
        </>
      )}
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  labels
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  labels?: Record<string, string>;
}): JSX.Element {
  return (
    <label className="grid gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels?.[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function EmptyPanel({ message }: { message: string }) {
  return <div className="rounded-[24px] border border-dashed border-slate-700 p-8 text-center text-slate-400">{message}</div>;
}
