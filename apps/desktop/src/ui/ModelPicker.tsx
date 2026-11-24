/** Model choice: presets plus a free-form id ("Özel…") for anything else the CLI accepts. */
import { useEffect, useState } from "react";
import { MODEL_PRESETS } from "../lib/format";
import { Input, Select } from "./kit";

const CUSTOM = "__custom__";

export function ModelPicker({ value, onChange, size = "md" }: { value: string; onChange: (next: string) => void; size?: "sm" | "md" }) {
  const isPreset = MODEL_PRESETS.some((preset) => preset.value === value);
  const [custom, setCustom] = useState(!isPreset);
  const [draft, setDraft] = useState(isPreset ? "" : value);
  useEffect(() => {
    const preset = MODEL_PRESETS.some((option) => option.value === value);
    setCustom(!preset);
    if (!preset) setDraft(value);
  }, [value]);
  const options = [...MODEL_PRESETS, { value: CUSTOM, label: "Özel…" }];
  return (
    <div className="flex items-center gap-2">
      <Select
        label="Model"
        value={custom ? CUSTOM : value}
        options={options}
        onChange={(next) => {
          if (next === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(next);
        }}
        className={size === "sm" ? "h-7 text-[12px]" : ""}
      />
      {custom && (
        <Input
          autoFocus
          value={draft}
          placeholder="ör. claude-opus-5-5"
          mono
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft.trim() && draft.trim() !== value && onChange(draft.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={size === "sm" ? "h-7 w-44 text-[12px]" : "w-48"}
        />
      )}
    </div>
  );
}
