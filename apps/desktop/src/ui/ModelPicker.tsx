/** Model choice: presets plus a free-form id ("Özel…") for anything else the CLI accepts. */
import { useEffect, useState } from "react";
import { MODEL_PRESETS, modelPreset } from "../lib/format";
import { Input, Select } from "./kit";

const CUSTOM = "__custom__";

export function ModelPicker({ value, onChange, size = "md" }: { value: string; onChange: (next: string) => void; size?: "sm" | "md" }) {
  const preset = modelPreset(value);
  const [custom, setCustom] = useState(preset === null);
  const [draft, setDraft] = useState(preset === null ? value : "");
  // Focus the id field only when the owner picks "Özel…", never just because a session reports an unusual model.
  const [focusDraft, setFocusDraft] = useState(false);
  useEffect(() => {
    const next = modelPreset(value);
    setCustom(next === null);
    if (next === null) setDraft(value);
  }, [value]);
  const options = [...MODEL_PRESETS, { value: CUSTOM, label: "Özel…" }];
  return (
    <div className="flex items-center gap-2" title={value && preset !== value ? value : undefined}>
      <Select
        label="Model"
        value={custom ? CUSTOM : (preset ?? "")}
        options={options}
        onChange={(next) => {
          if (next === CUSTOM) {
            setCustom(true);
            setFocusDraft(true);
            return;
          }
          setCustom(false);
          onChange(next);
        }}
        className={size === "sm" ? "h-7 text-[12px]" : ""}
      />
      {custom && (
        <Input
          autoFocus={focusDraft}
          value={draft}
          placeholder="ör. claude-opus-5-5"
          mono
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setFocusDraft(false);
            if (draft.trim() && draft.trim() !== value) onChange(draft.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={size === "sm" ? "h-7 w-44 text-[12px]" : "w-48"}
        />
      )}
    </div>
  );
}
