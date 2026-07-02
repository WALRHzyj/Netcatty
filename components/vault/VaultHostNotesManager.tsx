/**
 * VaultHostNotesManager — edit all host notes in one place, manually saved.
 *
 * Perf: edits a LOCAL React state named `draft`. The global hosts array is
 * only touched when the user clicks "Save" — no re-render storm while typing.
 */

import { FileText, Save, Trash2 } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { cn } from "../../lib/utils";
import type { Host } from "../../types";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { HostNotesEditor } from "../host/HostNotesEditor";

interface VaultHostNotesManagerProps {
  hosts: Host[];
  onUpdateHosts: (updater: Host[] | ((prev: Host[]) => Host[])) => void;
}

interface DraftState {
  notes: string;
  dirty: boolean;
}

const HostRow = memo<{
  host: Host;
  selected: boolean;
  hasNotes: boolean;
  dirty: boolean;
  onSelect: (id: string) => void;
}>(({ host, selected, hasNotes, dirty, onSelect }) => {
  const label = host.label || host.hostname || "(unnamed)";
  const sub = [host.hostname, host.username ? `@${host.username}` : "", host.protocol ? `(${host.protocol})` : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      onClick={() => onSelect(host.id)}
      className={cn(
        "w-full text-left px-3 py-2 rounded-md transition-colors",
        selected
          ? "bg-secondary border border-primary/30"
          : "hover:bg-secondary/60 border border-transparent",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <FileText size={13} className={cn("shrink-0", hasNotes ? "text-primary" : "text-muted-foreground/60")} />
        <span className="text-sm font-medium text-foreground truncate">{label}</span>
        {dirty && (
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        )}
      </div>
      {sub && (
        <div className="mt-0.5 ml-5 text-[11px] text-muted-foreground truncate">{sub}</div>
      )}
    </button>
  );
});

HostRow.displayName = "HostRow";

const VaultHostNotesManager: React.FC<VaultHostNotesManagerProps> = ({
  hosts,
  onUpdateHosts,
}) => {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const hostMap = useMemo(() => {
    const m = new Map<string, Host>();
    for (const h of hosts) m.set(h.id, h);
    return m;
  }, [hosts]);

  // Seed draft lazily on first select; keep selection valid on host list change.
  useEffect(() => {
    if (selectedId && !hostMap.has(selectedId)) {
      setSelectedId(hosts.length > 0 ? hosts[0].id : null);
    } else if (!selectedId && hosts.length > 0) {
      setSelectedId(hosts[0].id);
    }
  }, [hosts, hostMap, selectedId]);

  const ensureDraft = useCallback(
    (id: string) => {
      setDrafts((prev) => {
        if (prev[id]) return prev;
        const h = hostMap.get(id);
        if (!h) return prev;
        return { ...prev, [id]: { notes: h.notes ?? "", dirty: false } };
      });
    },
    [hostMap],
  );

  const selectHost = useCallback(
    (id: string) => {
      setSelectedId(id);
      ensureDraft(id);
    },
    [ensureDraft],
  );

  const handleNotesChange = useCallback(
    (id: string, notes: string) => {
      setDrafts((prev) => {
        const cur = prev[id];
        if (!cur) return prev;
        const canonical = hostMap.get(id)?.notes ?? "";
        return { ...prev, [id]: { notes, dirty: notes !== canonical } };
      });
    },
    [hostMap],
  );

  const save = useCallback(
    (id: string) => {
      const d = drafts[id];
      if (!d) return;
      onUpdateHosts((prev) => prev.map((h) => (h.id === id ? { ...h, notes: d.notes || undefined } : h)));
      setDrafts((prev) => ({ ...prev, [id]: { ...d, dirty: false } }));
    },
    [drafts, onUpdateHosts],
  );

  const revert = useCallback(
    (id: string) => {
      const canonical = hostMap.get(id)?.notes ?? "";
      setDrafts((prev) => ({ ...prev, [id]: { notes: canonical, dirty: false } }));
    },
    [hostMap],
  );

  const selectedHost = selectedId ? hostMap.get(selectedId) ?? null : null;
  const selectedDraft = selectedId ? drafts[selectedId] : null;
  const anyDirty = Object.values(drafts).some((d) => d.dirty);

  if (hosts.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground py-16 px-6">
        <div className="h-12 w-12 rounded-2xl bg-secondary flex items-center justify-center mb-3">
          <FileText size={24} className="opacity-50" />
        </div>
        <p className="text-sm">{t("hostNotesManager.empty.title")}</p>
        <p className="mt-1 text-xs text-center max-w-xs">
          {t("hostNotesManager.empty.desc")}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Left rail: host list */}
      <div className="w-[220px] shrink-0 border-r border-border/30 flex flex-col">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/30 bg-secondary/20">
          <p className="text-xs font-medium text-muted-foreground truncate">
            {t("hostNotesManager.hosts.count", { count: hosts.length })}
          </p>
          {anyDirty && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-500 font-medium shrink-0">
              {t("hostNotesManager.dirty")}
            </span>
          )}
        </div>
        <ScrollArea className="flex-1 px-2 py-2">
          <div className="space-y-1">
            {hosts.map((h) => (
              <HostRow
                key={h.id}
                host={h}
                selected={selectedId === h.id}
                hasNotes={!!h.notes?.trim()}
                dirty={drafts[h.id]?.dirty ?? false}
                onSelect={selectHost}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Right pane: active host editor */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selectedHost ? (
          <div className="h-full flex flex-col min-h-[480px]">
            {/* Header with title + dirty indicator + action buttons */}
            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border/30 bg-secondary/20 shrink-0">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {selectedHost.label || selectedHost.hostname}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {t("hostNotesManager.editingFor", { id: selectedHost.id.slice(0, 8) })}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {selectedDraft?.dirty && (
                  <span className="text-[10px] text-amber-500 mr-1.5">
                    {t("hostNotesManager.unsaved")}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1"
                  disabled={!selectedDraft?.dirty}
                  onClick={() => revert(selectedHost.id)}
                >
                  <Trash2 size={12} className="opacity-60" />
                  {t("hostNotesManager.revert")}
                </Button>
                <Button
                  size="sm"
                  className="h-8 gap-1"
                  disabled={!selectedDraft?.dirty}
                  onClick={() => save(selectedHost.id)}
                >
                  <Save size={12} />
                  {t("hostNotesManager.save")}
                </Button>
              </div>
            </div>
            {/* Editor area */}
            <div className="flex-1 overflow-hidden">
              <HostNotesEditor
                key={selectedHost.id}
                value={selectedDraft?.notes ?? selectedHost.notes ?? ""}
                onChange={(v) => handleNotesChange(selectedHost.id, v)}
                className="h-full"
                minHeight={320}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            {t("hostNotesManager.selectHost")}
          </div>
        )}
      </div>
    </div>
  );
};

export default VaultHostNotesManager;
