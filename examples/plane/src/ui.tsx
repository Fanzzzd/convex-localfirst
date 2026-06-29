import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from "react";
import { cn } from "./lib/cn";
import { PRIORITY_META, STATE_GROUP_META, type Priority, type StateGroup } from "./model";

// --- buttons ---------------------------------------------------------------
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "subtle" | "danger";
  size?: "sm" | "md" | "icon";
};

export function Button({ variant = "outline", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-7 px-2.5 text-xs",
        size === "md" && "h-8 px-3 text-sm",
        size === "icon" && "size-7",
        variant === "primary" && "brand-bg hover:opacity-90",
        variant === "outline" && "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
        variant === "ghost" && "text-zinc-600 hover:bg-zinc-100",
        variant === "subtle" && "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
        variant === "danger" && "border border-red-200 bg-white text-red-600 hover:bg-red-50",
        className
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400",
        className
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400",
        className
      )}
      {...props}
    />
  );
}

// --- modal -----------------------------------------------------------------
export function Modal({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className={cn("w-full max-w-lg rounded-xl border border-zinc-200 bg-white shadow-2xl", className)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// --- dropdown menu ---------------------------------------------------------
export function Menu({ trigger, children, align = "left", width }: { trigger: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          className={cn(
            "absolute z-40 mt-1 max-h-72 overflow-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-xl",
            align === "right" ? "right-0" : "left-0"
          )}
          style={{ minWidth: width ?? 180 }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, className }: { children: ReactNode; onClick?: () => void; active?: boolean; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100",
        active && "bg-zinc-100",
        className
      )}
    >
      {children}
    </button>
  );
}

// --- avatar ----------------------------------------------------------------
const AVATAR_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];
function hashColor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  const label = name.trim() || "?";
  return (
    <span
      title={label}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: hashColor(label), fontSize: size * 0.42 }}
    >
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function Badge({ color, children }: { color?: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium"
      style={color ? { borderColor: `${color}55`, color: color, background: `${color}14` } : undefined}
    >
      {color && <span className="size-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

// --- priority icon (Plane-style signal bars) -------------------------------
export function PriorityIcon({ priority, size = 16 }: { priority: Priority; size?: number }) {
  const meta = PRIORITY_META[priority];
  if (priority === "urgent") {
    return (
      <span
        className="inline-flex items-center justify-center rounded-[3px] font-bold text-white"
        style={{ width: size, height: size, background: meta.color, fontSize: size * 0.72, lineHeight: 1 }}
        title="Urgent"
      >
        !
      </span>
    );
  }
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;
  return (
    <span className="inline-flex items-end gap-px" style={{ height: size }} title={meta.label}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: size * 0.22,
            height: size * (0.4 + i * 0.28),
            borderRadius: 1,
            background: i < filled ? meta.color : undefined,
            border: i < filled ? undefined : "1px solid #d4d4d8"
          }}
        />
      ))}
    </span>
  );
}

// --- state icon (circle glyph by group) ------------------------------------
export function StateIcon({ group, color, size = 14 }: { group: StateGroup; color?: string; size?: number }) {
  const c = color ?? STATE_GROUP_META[group].color;
  const r = size / 2 - 1;
  const cx = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      {group === "backlog" && (
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={c} strokeWidth={1.4} strokeDasharray="2 2" />
      )}
      {group === "unstarted" && <circle cx={cx} cy={cx} r={r} fill="none" stroke={c} strokeWidth={1.6} />}
      {group === "started" && (
        <>
          <circle cx={cx} cy={cx} r={r} fill="none" stroke={c} strokeWidth={1.6} />
          <path d={`M ${cx} ${cx} L ${cx} ${cx - r} A ${r} ${r} 0 0 1 ${cx + r} ${cx} Z`} fill={c} />
        </>
      )}
      {group === "completed" && (
        <>
          <circle cx={cx} cy={cx} r={r} fill={c} />
          <path
            d={`M ${cx - r * 0.5} ${cx} l ${r * 0.35} ${r * 0.4} l ${r * 0.7} ${-r * 0.75}`}
            fill="none"
            stroke="#fff"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {group === "cancelled" && (
        <>
          <circle cx={cx} cy={cx} r={r} fill={c} />
          <path
            d={`M ${cx - r * 0.45} ${cx - r * 0.45} l ${r * 0.9} ${r * 0.9} M ${cx + r * 0.45} ${cx - r * 0.45} l ${-r * 0.9} ${r * 0.9}`}
            stroke="#fff"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}
