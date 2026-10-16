/**
 * The run hero's replay control: one split button. The left half plays or stops the replay; the right half shows the
 * current speed and opens a menu of speeds, each saying how long this run takes at it. A menu of radio items
 * (`menuitemradio`): opening it focuses the checked speed, the arrows, Home and End move, Enter or Space picks, Escape
 * closes and returns focus to the speed button; a click outside or Tab away closes it.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronUp, CirclePlay, Square } from "lucide-react";
import { REPLAY_SPEEDS, autoReplaySpeed, replaySpeedHint, replaySpeedLabel, type ReplaySpeedChoice } from "../lib/runsModel";

const HALF =
  "inline-flex min-h-11 items-center text-sm font-medium text-white hover:bg-gray-800 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export function ReplayControl({
  replaying,
  onToggle,
  speed,
  onSpeed,
  spanMs,
}: {
  replaying: boolean;
  onToggle: () => void;
  speed: ReplaySpeedChoice;
  onSpeed: (speed: ReplaySpeedChoice) => void;
  /** The recorded run's length, for the menu's "this run in" lines and Auto's speed. */
  spanMs: number;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  // Opening focuses the checked speed, as a radio group does.
  useEffect(() => {
    if (open) items.current[Math.max(0, REPLAY_SPEEDS.indexOf(speed))]?.focus();
  }, [open, speed]);

  // A click anywhere outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (s: ReplaySpeedChoice) => {
    onSpeed(s);
    close(true);
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const at = items.current.findIndex((el) => el === document.activeElement);
    const last = REPLAY_SPEEDS.length - 1;
    const go = (i: number) => {
      e.preventDefault();
      items.current[i]?.focus();
    };
    if (e.key === "ArrowDown") go(at >= last ? 0 : at + 1);
    else if (e.key === "ArrowUp") go(at <= 0 ? last : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(last);
    else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") close(false);
  };

  return (
    <div ref={root} className="relative inline-flex rounded-lg border border-gray-600">
      <button
        type="button"
        onClick={onToggle}
        title="Plays back on this page the steps this run recorded. It runs nothing: Retry with agent does."
        className={`${HALF} gap-2 rounded-l-lg px-4`}
      >
        {replaying ? <Square className="h-4 w-4" aria-hidden /> : <CirclePlay className="h-4 w-4" aria-hidden />}
        {replaying ? "Stop replay" : "Watch replay"}
      </button>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Replay speed: ${replaySpeedLabel(speed, spanMs)}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`${HALF} gap-1.5 rounded-r-lg border-l border-gray-600 pl-3.5 pr-3 ${open ? "bg-gray-800" : ""}`}
      >
        <span className="tabular-nums">{speed === "auto" ? `Auto · ${autoReplaySpeed(spanMs)}×` : `${speed}×`}</span>
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Replay speed"
          onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-20 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-gray-700 bg-gray-800 p-1.5 shadow-2xl shadow-black/50"
        >
          {REPLAY_SPEEDS.map((s, i) => {
            const checked = s === speed;
            return (
              <button
                key={s}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                tabIndex={-1}
                onClick={() => pick(s)}
                className={`grid w-full grid-cols-[1.25rem_1fr] gap-x-2.5 gap-y-0.5 rounded-lg px-3 py-2.5 text-left hover:bg-gray-700 focus-visible:bg-gray-700 focus-visible:outline-none ${checked ? "bg-gray-700/60" : ""}`}
              >
                <span className="row-span-2 pt-0.5 text-white">{checked && <Check className="h-4 w-4" aria-hidden />}</span>
                <span className="text-sm font-bold text-white">{replaySpeedLabel(s, spanMs)}</span>
                <span className="text-xs text-gray-400">{replaySpeedHint(s, spanMs)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
