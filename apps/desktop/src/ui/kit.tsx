/** Shared UI primitives in the Session Hub palette (harbor base, beacon accent). */
import { LoaderCircle } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useId, useState, type ButtonHTMLAttributes, type ComponentType, type KeyboardEvent, type ReactNode } from "react";

export type IconType = ComponentType<{ className?: string; strokeWidth?: number }>;

export function Card({ title, description, icon: Icon, actions, children, className = "" }: {
  title?: string;
  description?: ReactNode;
  icon?: IconType;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-white/[0.06] bg-gradient-to-b from-harbor-850/80 to-harbor-900/70 p-5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_12px_32px_-18px_rgba(0,0,0,0.7)] ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {Icon && <IconTile icon={Icon} />}
            <div>
              {title && <h3 className="font-display text-[15px] font-semibold tracking-tight text-ink-50">{title}</h3>}
              {description && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-400">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function IconTile({ icon: Icon, tone = "beacon" }: { icon: IconType; tone?: "beacon" | "harbor" | "rose" | "jade" }) {
  const tones = {
    beacon: "bg-beacon-400/10 text-beacon-300 ring-beacon-400/20",
    harbor: "bg-harbor-400/10 text-harbor-300 ring-harbor-400/20",
    rose: "bg-rose-glow/10 text-rose-glow ring-rose-glow/25",
    jade: "bg-jade/10 text-jade ring-jade/25",
  };
  return (
    <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ring-1 ${tones[tone]}`}>
      <Icon className="size-4" strokeWidth={2.2} />
    </span>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-white/[0.05] py-3.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-ink-50">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-400">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[46px] rounded-full p-[3px] transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-beacon-400/60 focus-visible:outline-none disabled:opacity-40 ${
        checked ? "bg-gradient-to-r from-beacon-500 to-beacon-300 shadow-[0_0_14px_rgba(255,169,92,0.35)]" : "bg-white/10"
      }`}
    >
      <motion.span layout transition={{ type: "spring", stiffness: 700, damping: 34 }} className={`block size-5 rounded-full shadow-md ${checked ? "ml-auto bg-harbor-950" : "bg-ink-200"}`} />
    </button>
  );
}

type ButtonVariant = "primary" | "ghost" | "subtle" | "danger" | "jade";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-gradient-to-b from-beacon-300 to-beacon-500 text-harbor-950 shadow-[0_6px_18px_-8px_rgba(255,169,92,0.8)] hover:brightness-110",
  ghost: "border border-white/10 bg-white/[0.04] text-ink-50 hover:bg-white/[0.08]",
  subtle: "text-ink-200 hover:bg-white/[0.06] hover:text-ink-50",
  danger: "border border-rose-glow/30 bg-rose-glow/10 text-rose-glow hover:bg-rose-glow/20",
  jade: "border border-jade/30 bg-jade/10 text-jade hover:bg-jade/20",
};

export function Button({ variant = "ghost", icon: Icon, loading = false, size = "md", children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: IconType;
  loading?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const sizes = { sm: "h-7 px-2.5 text-[12.5px]", md: "h-8 px-3 text-[13px]", lg: "h-10 px-4 text-[13.5px]" };
  return (
    <button
      type="button"
      {...rest}
      disabled={(rest.disabled ?? false) || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-all duration-200 focus-visible:ring-2 focus-visible:ring-beacon-400/60 focus-visible:outline-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 ${sizes[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : Icon ? <Icon className="size-3.5" strokeWidth={2.3} /> : null}
      {children}
    </button>
  );
}

export function Select<T extends string>({ value, options, onChange, label, className = "" }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        const next = options.find((option) => option.value === event.target.value);
        if (next) onChange(next.value);
      }}
      className={`h-8 rounded-lg border border-white/10 bg-harbor-900 px-2.5 pr-8 text-[13px] text-ink-50 outline-none focus:border-beacon-400/60 ${className}`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const fieldBase = "rounded-lg border border-white/10 bg-harbor-950/70 px-3 text-[13px] text-ink-50 placeholder:text-ink-500 outline-none transition-colors focus:border-beacon-400/60";

/** Text input with a local draft; commits on blur or Enter, Escape reverts. */
export function TextField({ value, onCommit, placeholder, type = "text", mono = false, className = "", label }: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "number" | "url";
  mono?: boolean;
  className?: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      event.preventDefault(); // this Esc reverts the field; it must not also close the screen
      setDraft(value);
      event.currentTarget.blur();
    }
  };
  return (
    <input
      aria-label={label}
      type={type}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      className={`${fieldBase} h-8 ${mono ? "font-mono text-[12.5px]" : ""} ${className}`}
    />
  );
}

/** Controlled input for forms (no commit-on-blur). */
export function Input({ className = "", mono = false, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input spellCheck={false} autoCorrect="off" autoCapitalize="off" {...rest} className={`${fieldBase} h-9 ${mono ? "font-mono text-[12.5px]" : ""} ${className}`} />;
}

export function TextArea({ className = "", ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`${fieldBase} w-full resize-none py-2.5 leading-relaxed ${className}`} />;
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  size?: "sm" | "md";
}) {
  const groupId = useId();
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-harbor-950/60 p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`relative rounded-md px-3 font-medium transition-colors ${size === "sm" ? "h-6 text-[12px]" : "h-7 text-[12.5px]"} ${active ? "text-harbor-950" : "text-ink-400 hover:text-ink-50"}`}
          >
            {active && (
              <motion.span layoutId={`seg-${groupId}`} className="absolute inset-0 rounded-md bg-gradient-to-b from-beacon-300 to-beacon-500" transition={{ type: "spring", stiffness: 600, damping: 38 }} />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export type Tone = "ok" | "attention" | "error" | "busy" | "idle" | "deferred";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-jade shadow-[0_0_8px_rgba(95,212,160,0.75)]",
  attention: "bg-beacon-400 shadow-[0_0_10px_rgba(255,169,92,0.9)]",
  error: "bg-rose-glow shadow-[0_0_8px_rgba(255,107,122,0.8)]",
  busy: "bg-harbor-300 animate-pulse",
  idle: "bg-ink-500",
  deferred: "bg-violet-glow shadow-[0_0_8px_rgba(167,139,250,0.7)]",
};

/** Status dot; "attention" adds a beacon sweep ring (only while something waits for the owner). */
export function StatusDot({ tone, size = "md" }: { tone: Tone; size?: "sm" | "md" }) {
  const dimension = size === "sm" ? "size-1.5" : "size-2";
  return (
    <span className={`relative inline-flex shrink-0 ${dimension}`}>
      {tone === "attention" && <span className="absolute inset-0 rounded-full bg-beacon-400 [animation:beacon-pulse_1.8s_ease-out_infinite]" />}
      <span className={`relative inline-block rounded-full ${dimension} ${TONE_CLASS[tone]}`} />
    </span>
  );
}

export function SectionHeader({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-[26px] font-semibold tracking-tight text-ink-50">{title}</h1>
        <p className="mt-1 text-[13.5px] text-ink-400">{subtitle}</p>
      </div>
      {actions}
    </div>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "beacon" | "rose" | "jade" | "violet" }) {
  const tones = {
    neutral: "border-white/10 bg-white/[0.04] text-ink-200",
    beacon: "border-beacon-400/30 bg-beacon-400/10 text-beacon-200",
    rose: "border-rose-glow/30 bg-rose-glow/10 text-rose-glow",
    jade: "border-jade/30 bg-jade/10 text-jade",
    violet: "border-violet-glow/30 bg-violet-glow/10 text-violet-glow",
  };
  return <span className={`inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function EmptyState({ icon, title, body, action }: { icon: IconType; title: string; body: string; action?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }} className="flex flex-col items-center px-8 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-beacon-400/10 text-beacon-300 ring-1 ring-beacon-400/20 shadow-[0_0_40px_-10px_rgba(255,169,92,0.5)]">
        {(() => {
          const Icon = icon;
          return <Icon className="size-6" strokeWidth={2.2} />;
        })()}
      </span>
      <h2 className="mt-5 font-display text-[18px] font-semibold tracking-tight text-ink-50">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-400">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}
