import { ChevronDown, Pencil, RotateCcw, Save, X } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { cn } from "../../lib/utils";
import { buildDefaultSystemPromptTemplate } from "../../infrastructure/ai/cattyAgent/systemPromptRuntime";
import { CONTEXT_COMPACTION_SYSTEM_PROMPT } from "../../infrastructure/ai/contextCompaction";
import { REVIEW_SYSTEM_PROMPT } from "../../infrastructure/ai/review/commandReviewer";
import {
  AI_PROMPT_IDS,
  type AIPromptId,
  type AIPromptPresets,
} from "../../infrastructure/ai/promptPresets";
import type { Host } from "../../types";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { toast } from "../ui/toast";
import VaultHostNotesManager from "./VaultHostNotesManager";

/** Shipped defaults, used to display diffs and restore-from-default actions. */
const SHIPPED_DEFAULTS: Record<AIPromptId, () => string> = {
  "catty:system": buildDefaultSystemPromptTemplate,
  "catty:compaction": () => CONTEXT_COMPACTION_SYSTEM_PROMPT,
  "catty:review": () => REVIEW_SYSTEM_PROMPT,
};

const SYSTEM_PROMPT_IDS: AIPromptId[] = ["catty:system", "catty:compaction", "catty:review"];

interface AIPromptPresetsManagerProps {
  aiPromptPresets: AIPromptPresets;
  onUpdateAiPromptPresets: (next: AIPromptPresets) => void;
  hosts?: Host[];
  onUpdateHosts?: (updater: Host[] | ((prev: Host[]) => Host[])) => void;
}

const PromptCard = memo<{
  id: AIPromptId;
  isEditing: boolean;
  draft: string;
  isCustom: boolean;
  onStartEdit: (id: AIPromptId) => void;
  onCancel: () => void;
  onSave: (id: AIPromptId, text: string) => void;
  onReset: (id: AIPromptId) => void;
  onDraftChange: (id: AIPromptId, text: string) => void;
}>(({
  id,
  isEditing,
  draft,
  isCustom,
  onStartEdit,
  onCancel,
  onSave,
  onReset,
  onDraftChange,
}) => {
  const { t } = useI18n();
  const name = t(`aiPromptPresets.card.${id}.name` as const);
  const desc = t(`aiPromptPresets.card.${id}.desc` as const);
  const isSystem = id === "catty:system";

  return (
    <div className="rounded-lg border border-border/60 bg-secondary/20 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border/30 bg-secondary/30">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">{name}</span>
            <Badge
              variant={isCustom ? "default" : "outline"}
              className={cn(
                "text-[10px] h-5 px-1.5 shrink-0",
                isCustom
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "border-border/60 text-muted-foreground",
              )}
            >
              {isCustom
                ? t("aiPromptPresets.badge.custom")
                : t("aiPromptPresets.badge.default")}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{desc}</p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isEditing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1"
                onClick={() => onCancel()}
              >
                <X size={12} />
                {t("aiPromptPresets.cancel")}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1"
                onClick={() => onSave(id, draft)}
              >
                <Save size={12} />
                {t("aiPromptPresets.save")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1"
                onClick={() => onStartEdit(id)}
              >
                <Pencil size={12} />
                {t("aiPromptPresets.edit")}
              </Button>
              {isCustom && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 text-muted-foreground hover:text-foreground"
                  onClick={() => onReset(id)}
                >
                  <RotateCcw size={12} />
                  {t("aiPromptPresets.reset")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="px-4 py-3 space-y-2">
        <Textarea
          readOnly={!isEditing}
          value={draft}
          onChange={(e) => onDraftChange(id, e.target.value)}
          className={cn(
            "min-h-[200px] font-mono text-xs leading-relaxed resize-y",
            isEditing
              ? "bg-background border-border/80 focus:border-primary/60"
              : "bg-secondary/30 border-border/30 cursor-default",
          )}
        />
        <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>{t("aiPromptPresets.charCount", { n: draft.length })}</span>
          {isSystem && (
            <span className="text-amber-500 dark:text-amber-400 truncate max-w-[60%]">
              {t("aiPromptPresets.warn.tokens")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

PromptCard.displayName = "PromptCard";

const CollapsibleSection = memo<{
  title: string;
  desc?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}>(({ title, desc, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-secondary/30 hover:bg-secondary/50 transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ChevronDown
              size={14}
              className={cn(
                "shrink-0 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
            <span className="text-sm font-semibold text-foreground truncate">{title}</span>
          </div>
          {desc && (
            <p className="mt-0.5 ml-6 text-xs text-muted-foreground line-clamp-2">{desc}</p>
          )}
        </div>
      </button>
      {open && (
        <div className="p-3 bg-background space-y-3">
          {children}
        </div>
      )}
    </div>
  );
});

CollapsibleSection.displayName = "CollapsibleSection";

const AIPromptPresetsManager: React.FC<AIPromptPresetsManagerProps> = ({
  aiPromptPresets,
  onUpdateAiPromptPresets,
  hosts = [],
  onUpdateHosts,
}) => {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<AIPromptId | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<AIPromptId, string>>>({});

  const resolveCurrent = useCallback(
    (id: AIPromptId): string => {
      const override = aiPromptPresets.overrides[id];
      return typeof override === "string" && override.trim().length > 0
        ? override
        : SHIPPED_DEFAULTS[id]();
    },
    [aiPromptPresets.overrides],
  );

  const isCustom = useCallback(
    (id: AIPromptId): boolean => {
      const v = aiPromptPresets.overrides[id];
      return typeof v === "string" && v.trim().length > 0;
    },
    [aiPromptPresets.overrides],
  );

  const startEdit = useCallback(
    (id: AIPromptId) => {
      setEditingId(id);
      setDrafts((prev) => ({ ...prev, [id]: resolveCurrent(id) }));
    },
    [resolveCurrent],
  );

  const cancel = useCallback(() => {
    setEditingId((current) => {
      if (current) {
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[current];
          return next;
        });
      }
      return null;
    });
  }, []);

  const save = useCallback(
    (id: AIPromptId, text: string) => {
      const trimmed = text;
      const fallbackText = SHIPPED_DEFAULTS[id]();

      const isIdenticalDefault = trimmed.trim() === fallbackText.trim();
      const nextOverrides = { ...aiPromptPresets.overrides };
      if (isIdenticalDefault || trimmed.trim().length === 0) {
        delete nextOverrides[id];
      } else {
        nextOverrides[id] = trimmed;
      }
      onUpdateAiPromptPresets({ overrides: nextOverrides });
      setEditingId(null);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (isIdenticalDefault) {
        toast.success(t("aiPromptPresets.reset.success"));
      } else {
        toast.success(t("aiPromptPresets.save.success"));
      }
    },
    [aiPromptPresets.overrides, onUpdateAiPromptPresets, t],
  );

  const reset = useCallback(
    (id: AIPromptId) => {
      const nextOverrides = { ...aiPromptPresets.overrides };
      delete nextOverrides[id];
      onUpdateAiPromptPresets({ overrides: nextOverrides });
      toast.success(t("aiPromptPresets.reset.success"));
    },
    [aiPromptPresets.overrides, onUpdateAiPromptPresets, t],
  );

  const resetAll = useCallback(() => {
    onUpdateAiPromptPresets({ overrides: {} });
    setEditingId(null);
    setDrafts({});
    toast.success(t("aiPromptPresets.reset.success"));
  }, [onUpdateAiPromptPresets, t]);

  const anyCustom = useMemo(
    () => AI_PROMPT_IDS.some((id) => isCustom(id)),
    [isCustom],
  );

  const handleDraftChange = useCallback(
    (id: AIPromptId, text: string) => {
      setDrafts((prev) => ({ ...prev, [id]: text }));
    },
    [],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border/30 bg-secondary/20">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">
              {t("aiPromptPresets.title")}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {t("aiPromptPresets.desc")}
            </p>
          </div>
          {anyCustom && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 shrink-0"
              onClick={resetAll}
            >
              <RotateCcw size={12} />
              {t("aiPromptPresets.resetAll")}
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 py-3 space-y-3">
          <CollapsibleSection
            title={t("aiPromptPresets.section.system.title")}
            desc={t("aiPromptPresets.section.system.desc")}
          >
            {SYSTEM_PROMPT_IDS.map((id) => (
              <PromptCard
                key={id}
                id={id}
                isEditing={editingId === id}
                draft={
                  editingId === id
                    ? (drafts[id] ?? resolveCurrent(id))
                    : resolveCurrent(id)
                }
                isCustom={isCustom(id)}
                onStartEdit={startEdit}
                onCancel={cancel}
                onSave={save}
                onReset={reset}
                onDraftChange={handleDraftChange}
              />
            ))}
          </CollapsibleSection>

          <CollapsibleSection
            title={t("aiPromptPresets.section.user.title")}
            desc={t("aiPromptPresets.section.user.desc")}
          >
            <div className="h-[420px] rounded-md border border-border/40 overflow-hidden">
              <VaultHostNotesManager
                hosts={hosts}
                onUpdateHosts={onUpdateHosts ?? (() => {})}
              />
            </div>
          </CollapsibleSection>
        </div>
      </ScrollArea>
    </div>
  );
};

export default AIPromptPresetsManager;
