import {
    Bookmark,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    CircleUserRound,
    RotateCcw,
    Search,
    Server,
    Terminal,
    Trash2,
    Usb,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { resolveHostIconAppearance } from "../domain/hostIcon";
import { cn } from "../lib/utils";
import { ConnectionLog, Host } from "../types";
import { DistroAvatar } from "./DistroAvatar";
import { Combobox, ComboboxOption } from "./ui/combobox";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// ---------------------------------------------------------------------------
// Date range helpers (local-time day boundaries)
// ---------------------------------------------------------------------------

/** Parse a "YYYY-MM-DD" string into UTC ms at local 00:00:00.000. */
const parseDateStart = (yyyymmdd: string | undefined): number | null => {
    if (!yyyymmdd) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const d = new Date(year, month - 1, day, 0, 0, 0, 0);
    // Guard against overflow like "2026-02-31" rolling into March.
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d.getTime();
};

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// ConnectionLogsManager types
// ---------------------------------------------------------------------------

type DateRangePreset = "today" | "7d" | "30d" | "all" | "custom";

interface LogFilters {
    rangePreset: DateRangePreset;
    /** "YYYY-MM-DD" — used only when preset === 'custom'. */
    dateFrom: string;
    dateTo: string;
    /** "all" means no host filter; otherwise equals a concrete connect.log.hostname. */
    hostFilter: string;
    /** Substring query against localUsername / username / localHostname. */
    userQuery: string;
}

const DEFAULT_FILTERS: LogFilters = {
    rangePreset: "all",
    dateFrom: "",
    dateTo: "",
    hostFilter: "all",
    userQuery: "",
};

const isDefaultFilters = (f: LogFilters): boolean =>
    f.rangePreset === DEFAULT_FILTERS.rangePreset &&
    f.dateFrom === DEFAULT_FILTERS.dateFrom &&
    f.dateTo === DEFAULT_FILTERS.dateTo &&
    f.hostFilter === DEFAULT_FILTERS.hostFilter &&
    f.userQuery === DEFAULT_FILTERS.userQuery;

type PageSize = 20 | 50 | 100;
const PAGE_SIZES: PageSize[] = [20, 50, 100];

// ---------------------------------------------------------------------------
// ConnectionLogsManager props
// ---------------------------------------------------------------------------

interface ConnectionLogsManagerProps {
    logs: ConnectionLog[];
    hosts: Host[];
    onToggleSaved: (id: string) => void;
    onDelete: (id: string) => void;
    onClearUnsaved: () => void;
    onOpenLogView: (log: ConnectionLog) => void;
}

// ---------------------------------------------------------------------------
// Date formatting display helpers
// ---------------------------------------------------------------------------

const formatDate = (timestamp: number, locale: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(locale || undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
};

const formatTimeRange = (start: number, end: number | undefined, locale: string, ongoingLabel: string) => {
    const startDate = new Date(start);
    const startTime = startDate.toLocaleTimeString(locale || undefined, {
        hour: "2-digit",
        minute: "2-digit",
    });

    if (!end) {
        return `${startTime} - ${ongoingLabel}`;
    }

    const endDate = new Date(end);
    const endTime = endDate.toLocaleTimeString(locale || undefined, {
        hour: "2-digit",
        minute: "2-digit",
    });

    return `${startTime} - ${endTime}`;
};

// ---------------------------------------------------------------------------
// LogItem — presentational row
// ---------------------------------------------------------------------------

interface LogItemProps {
    log: ConnectionLog;
    onToggleSaved: (id: string) => void;
    onDelete: (id: string) => void;
    onClick: () => void;
}

const LogItem = memo<LogItemProps>(({ log, onToggleSaved, onDelete, onClick }) => {
    const { t, resolvedLocale } = useI18n();
    const isLocal = log.protocol === "local" || log.hostname === "localhost";
    const isSerial = log.protocol === "serial";
    const customHostIcon = resolveHostIconAppearance({
        iconMode: log.hostIconMode,
        iconId: log.hostIconId,
        iconColorMode: log.hostIconColorMode,
        iconColor: log.hostIconColor,
        iconColorCustom: log.hostIconColorCustom,
    });
    const hasPersistedHostIcon = !isLocal && !isSerial && (!!log.hostDistro || !!customHostIcon);

    return (
        <div
            className="group flex items-center gap-4 px-4 py-3 hover:bg-secondary/60 transition-colors border-b border-border/30 last:border-b-0 cursor-pointer"
            onClick={onClick}
        >
            {/* Date column */}
            <div className="w-32 shrink-0">
                <div className="text-sm font-medium">{formatDate(log.startTime, resolvedLocale)}</div>
                <div className="text-xs text-muted-foreground">
                    {formatTimeRange(log.startTime, log.endTime, resolvedLocale, t("logs.ongoing"))}
                </div>
            </div>

            {/* User column */}
            <div className="flex items-center gap-2 w-56 shrink-0">
                <div className="h-9 w-9 rounded-xl bg-emerald-600 text-white dark:bg-emerald-400 dark:text-slate-950 flex items-center justify-center shrink-0">
                    <CircleUserRound size={18} strokeWidth={2.25} />
                </div>
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{log.localUsername}</div>
                    <div className="text-xs text-muted-foreground truncate">{log.localHostname}</div>
                </div>
            </div>

            {/* Host column */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
                {hasPersistedHostIcon ? (
                    <DistroAvatar
                        host={{
                            os: log.hostOs ?? "linux",
                            distro: log.hostDistro,
                            distroMode: "auto",
                            iconMode: log.hostIconMode,
                            iconId: log.hostIconId,
                            iconColorMode: log.hostIconColorMode,
                            iconColor: log.hostIconColor,
                            iconColorCustom: log.hostIconColorCustom,
                        }}
                        fallback={(log.hostOs ?? "linux")[0].toUpperCase()}
                        size="log"
                    />
                ) : (
                    <div className={cn(
                        "h-9 w-9 rounded-xl flex items-center justify-center shrink-0",
                        isSerial
                            ? "bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950"
                            : isLocal
                                ? "bg-slate-600 text-white dark:bg-slate-300 dark:text-slate-950"
                                : "bg-primary text-primary-foreground",
                    )}>
                        {isSerial ? <Usb size={17} /> : isLocal ? <Terminal size={17} /> : <Server size={17} />}
                    </div>
                )}
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{isLocal ? t("logs.localTerminal") : log.hostLabel}</div>
                    <div className="text-xs text-muted-foreground truncate">
                        {isLocal ? "local" : isSerial ? `serial, ${log.hostname}` : `${log.protocol}, ${log.username}`}
                    </div>
                </div>
            </div>

            {/* Saved column */}
            <div className="flex items-center gap-2 shrink-0">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleSaved(log.id);
                            }}
                            className={cn(
                                "p-1.5 rounded-md transition-colors",
                                log.saved
                                    ? "text-primary bg-primary/10"
                                    : "text-muted-foreground hover:text-primary hover:bg-primary/10",
                            )}
                        >
                            <Bookmark size={16} fill={log.saved ? "currentColor" : "none"} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{log.saved ? t("logs.action.unsave") : t("logs.action.save")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(log.id);
                            }}
                            className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                        >
                            <Trash2 size={16} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("logs.action.delete")}</TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
});

LogItem.displayName = "LogItem";

// ---------------------------------------------------------------------------
// DateRangeToggle — preset / custom date filter bar segment
// ---------------------------------------------------------------------------

interface DateRangeToggleProps {
    value: DateRangePreset;
    onChange: (next: DateRangePreset) => void;
    dateFrom: string;
    dateTo: string;
    onDateFromChange: (v: string) => void;
    onDateToChange: (v: string) => void;
}

const DateRangeToggle: React.FC<DateRangeToggleProps> = ({
    value,
    onChange,
    dateFrom,
    dateTo,
    onDateFromChange,
    onDateToChange,
}) => {
    const { t } = useI18n();
    const presets: DateRangePreset[] = ["today", "7d", "30d", "all", "custom"];
    const isCustom = value === "custom";

    return (
        <div className="flex flex-col gap-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/80">
                {t("logs.filter.datePreset")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-secondary/60 p-0.5">
                    {presets.map((p) => {
                        const active = value === p;
                        return (
                            <button
                                key={p}
                                type="button"
                                onClick={() => onChange(p)}
                                className={cn(
                                    "rounded-md px-3 py-1.5 text-xs font-medium transition",
                                    active
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                                )}
                            >
                                {t(`logs.filter.datePreset.${p}` as const)}
                            </button>
                        );
                    })}
                </div>
                {isCustom && (
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                            <span className="text-[11px] text-muted-foreground/80">{t("logs.filter.dateFrom")}</span>
                            <Input
                                type="date"
                                value={dateFrom}
                                onChange={(e) => onDateFromChange(e.target.value)}
                                className="h-8 w-[140px] px-2 text-xs"
                            />
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-[11px] text-muted-foreground/80">{t("logs.filter.dateTo")}</span>
                            <Input
                                type="date"
                                value={dateTo}
                                onChange={(e) => onDateToChange(e.target.value)}
                                className="h-8 w-[140px] px-2 text-xs"
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

interface FilterBarProps {
    filters: LogFilters;
    onChange: (patch: Partial<LogFilters>) => void;
    onReset: () => void;
    /** Distinct hostnames present after date-filtering, for the host dropdown. */
    hostOptions: ComboboxOption[];
    dateFrom: string;
    dateTo: string;
    hostFilter: string;
    onDateFromChange: (v: string) => void;
    onDateToChange: (v: string) => void;
    onHostFilterChange: (v: string) => void;
    userQuery: string;
    userQueryOnChange: (v: string) => void;
}

const FilterBar: React.FC<FilterBarProps> = ({
    filters,
    onChange,
    onReset,
    hostOptions,
    dateFrom,
    dateTo,
    hostFilter,
    onDateFromChange,
    onDateToChange,
    onHostFilterChange,
    userQuery,
    userQueryOnChange,
}) => {
    const { t } = useI18n();
    const hasActiveFilter = !isDefaultFilters(filters);

    return (
        <div className="flex flex-col gap-3 px-4 py-3 bg-secondary/20 border-b border-border/30">
            <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-muted-foreground">{t("logs.filter.title")}</div>
                {hasActiveFilter && (
                    <button
                        type="button"
                        onClick={onReset}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <RotateCcw size={12} />
                        {t("logs.filter.clear")}
                    </button>
                )}
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <DateRangeToggle
                    value={filters.rangePreset}
                    onChange={(rangePreset) => onChange({ rangePreset })}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onDateFromChange={onDateFromChange}
                    onDateToChange={onDateToChange}
                />

                <div className="flex flex-col gap-2">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground/80">
                        {t("logs.filter.host")}
                    </div>
                    <Combobox
                        options={hostOptions}
                        value={hostFilter}
                        onValueChange={onHostFilterChange}
                        placeholder={t("logs.filter.hostPlaceholder")}
                        className="w-full"
                        triggerClassName="h-9 text-sm bg-background"
                    />
                </div>

                <div className="flex flex-col gap-2">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground/80">
                        {t("logs.filter.user")}
                    </div>
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={userQuery}
                            onChange={(e) => userQueryOnChange(e.target.value)}
                            placeholder={t("logs.filter.userPlaceholder")}
                            className="pl-9 h-9 bg-background border-border/60 text-sm"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

interface PaginationProps {
    pageIndex: number;
    pageSize: PageSize;
    totalCount: number;
    onPageChange: (index: number) => void;
    onPageSizeChange: (size: PageSize) => void;
}

const Pagination: React.FC<PaginationProps> = ({
    pageIndex,
    pageSize,
    totalCount,
    onPageChange,
    onPageSizeChange,
}) => {
    const { t } = useI18n();
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const clamped = Math.min(pageIndex, totalPages - 1);
    const from = totalCount === 0 ? 0 : clamped * pageSize + 1;
    const to = Math.min((clamped + 1) * pageSize, totalCount);

    const canPrev = clamped > 0;
    const canNext = clamped < totalPages - 1;

    return (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/30 bg-secondary/20 px-4 py-2 text-xs">
            <div className="flex items-center gap-3 text-muted-foreground">
                <span>{t("logs.pagination.summary", { from, to, total: totalCount })}</span>
                <span className="hidden sm:inline">·</span>
                <span className="hidden sm:inline">{t("logs.pagination.pageIndicator", { current: clamped + 1, total: totalPages })}</span>
            </div>

            <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 text-muted-foreground">
                    <span className="hidden sm:inline">{t("logs.pagination.pageSize")}</span>
                    <select
                        value={pageSize}
                        onChange={(e) => onPageSizeChange(Number(e.target.value) as PageSize)}
                        className="h-8 px-2 text-xs border border-border/60 bg-secondary rounded-md focus:outline-none focus:ring-1 focus:ring-primary/40 text-foreground"
                        aria-label={t("logs.pagination.pageSize")}
                    >
                        {PAGE_SIZES.map((s) => (
                            <option key={s} value={s}>
                                {s}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="inline-flex items-center gap-0.5">
                    <button
                        type="button"
                        disabled={!canPrev}
                        onClick={() => onPageChange(0)}
                        aria-label={t("logs.pagination.first")}
                        className={cn(
                            "h-8 w-8 inline-flex items-center justify-center rounded-md border border-border/60 transition",
                            canPrev
                                ? "text-foreground hover:bg-muted/60"
                                : "text-muted-foreground/50 cursor-not-allowed",
                        )}
                    >
                        <ChevronLeft size={14} />
                        <ChevronLeft size={14} className="-ml-2" />
                    </button>
                    <button
                        type="button"
                        disabled={!canPrev}
                        onClick={() => onPageChange(clamped - 1)}
                        aria-label={t("logs.pagination.prev")}
                        className={cn(
                            "h-8 w-8 inline-flex items-center justify-center rounded-md border border-border/60 transition",
                            canPrev
                                ? "text-foreground hover:bg-muted/60"
                                : "text-muted-foreground/50 cursor-not-allowed",
                        )}
                    >
                        <ChevronLeft size={14} />
                    </button>

                    <span className="h-8 min-w-[60px] px-2 inline-flex items-center justify-center text-xs text-muted-foreground">
                        {clamped + 1} / {totalPages}
                    </span>

                    <button
                        type="button"
                        disabled={!canNext}
                        onClick={() => onPageChange(clamped + 1)}
                        aria-label={t("logs.pagination.next")}
                        className={cn(
                            "h-8 w-8 inline-flex items-center justify-center rounded-md border border-border/60 transition",
                            canNext
                                ? "text-foreground hover:bg-muted/60"
                                : "text-muted-foreground/50 cursor-not-allowed",
                        )}
                    >
                        <ChevronRight size={14} />
                    </button>
                    <button
                        type="button"
                        disabled={!canNext}
                        onClick={() => onPageChange(totalPages - 1)}
                        aria-label={t("logs.pagination.last")}
                        className={cn(
                            "h-8 w-8 inline-flex items-center justify-center rounded-md border border-border/60 transition",
                            canNext
                                ? "text-foreground hover:bg-muted/60"
                                : "text-muted-foreground/50 cursor-not-allowed",
                        )}
                    >
                        <ChevronRight size={14} />
                        <ChevronRight size={14} className="-ml-2" />
                    </button>
                </div>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

const EmptyLogsState: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
            <Terminal size={32} className="opacity-60" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
        <p className="text-sm text-center max-w-sm">{desc}</p>
    </div>
);

// ---------------------------------------------------------------------------
// ConnectionLogsManager
// ---------------------------------------------------------------------------

const ConnectionLogsManager: React.FC<ConnectionLogsManagerProps> = ({
    logs,
    hosts: _hosts,
    onToggleSaved,
    onDelete,
    onClearUnsaved: _onClearUnsaved,
    onOpenLogView,
}) => {
    const { t } = useI18n();

    // --- filter state -------------------------------------------------------
    const [filters, setFilters] = useState<LogFilters>(DEFAULT_FILTERS);
    // --- pagination state ---------------------------------------------------
    const [pageIndex, setPageIndex] = useState(0);
    const [pageSize, setPageSize] = useState<PageSize>(50);

    // Capture "today" once on mount so preset range boundaries stay stable.
    const todayStart = useMemo(() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }, []);

    const resetFilters = useCallback(() => {
        setFilters(DEFAULT_FILTERS);
        setPageIndex(0);
    }, []);

    const patchFilters = useCallback((patch: Partial<LogFilters>) => {
        setFilters((prev) => ({ ...prev, ...patch }));
        setPageIndex(0);
    }, []);

    // --- date range boundaries resolved from filters ------------------------
    const dateRangeBounds = useMemo((): [number, number] | null => {
        if (filters.rangePreset === "all") return null;
        if (filters.rangePreset === "today") return [todayStart, todayStart + DAY_MS - 1];
        if (filters.rangePreset === "7d") return [todayStart - 6 * DAY_MS, todayStart + DAY_MS - 1];
        if (filters.rangePreset === "30d") return [todayStart - 29 * DAY_MS, todayStart + DAY_MS - 1];
        // custom
        const from = parseDateStart(filters.dateFrom);
        if (from === null) return null;
        const to = parseDateStart(filters.dateTo);
        const toBound = to === null ? from + DAY_MS - 1 : to + DAY_MS - 1;
        return [from, Math.max(from, toBound)];
    }, [filters.rangePreset, filters.dateFrom, filters.dateTo, todayStart]);

    // --- host options derived from logs already filtered by date -----------
    const dateFilteredLogs = useMemo(() => {
        if (!dateRangeBounds) return logs;
        const [from, to] = dateRangeBounds;
        return logs.filter((l) => l.startTime >= from && l.startTime <= to);
    }, [logs, dateRangeBounds]);

    const hostOptions = useMemo<ComboboxOption[]>(() => {
        const seen = new Set<string>();
        for (const l of dateFilteredLogs) seen.add(l.hostname);
        const hostOnly: ComboboxOption[] = [...seen]
            .sort((a, b) => a.localeCompare(b))
            .map((h) => ({ value: h, label: h }));
        return [
            { value: "all", label: t("logs.filter.hostPlaceholder") },
            ...hostOnly,
        ];
    }, [dateFilteredLogs, t]);

    // If current hostFilter value is no longer valid (date filter removed it),
    // silently reset to "all". Keeps the dropdown consistent with data.
    const effectiveHostFilter = useMemo(() => {
        if (filters.hostFilter === "all") return "all";
        const stillPresent = dateFilteredLogs.some((l) => l.hostname === filters.hostFilter);
        return stillPresent ? filters.hostFilter : "all";
    }, [filters.hostFilter, dateFilteredLogs]);

    React.useEffect(() => {
        // Sync hostFilter when the date range no longer contains the previously
        // selected host — otherwise the combobox would show a stale value
        // while the list is effectively not filtered by that host.
        if (effectiveHostFilter !== filters.hostFilter) {
            setFilters((prev) => ({ ...prev, hostFilter: effectiveHostFilter }));
        }
    }, [effectiveHostFilter, filters.hostFilter]);

    // --- final filtered + sorted logs --------------------------------------
    const filteredLogs = useMemo(() => {
        const userQ = filters.userQuery.trim().toLowerCase();
        const result = dateFilteredLogs.filter((l) => {
            if (effectiveHostFilter !== "all" && l.hostname !== effectiveHostFilter) return false;
            if (userQ) {
                const haystack = [l.localUsername, l.username, l.localHostname]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();
                if (!haystack.includes(userQ)) return false;
            }
            return true;
        });
        result.sort((a, b) => b.startTime - a.startTime);
        return result;
    }, [dateFilteredLogs, effectiveHostFilter, filters.userQuery]);

    // --- pagination slice --------------------------------------------------
    const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));
    const currentPage = Math.min(pageIndex, totalPages - 1);
    const displayedLogs = useMemo(
        () => filteredLogs.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
        [filteredLogs, currentPage, pageSize],
    );

    // --- handlers ----------------------------------------------------------
    const handleToggleSaved = useCallback((id: string) => onToggleSaved(id), [onToggleSaved]);
    const handleDelete = useCallback((id: string) => onDelete(id), [onDelete]);

    const renderedItems = useMemo(
        () =>
            displayedLogs.map((log) => (
                <LogItem
                    key={log.id}
                    log={log}
                    onToggleSaved={handleToggleSaved}
                    onDelete={handleDelete}
                    onClick={() => onOpenLogView(log)}
                />
            )),
        [displayedLogs, handleToggleSaved, handleDelete, onOpenLogView],
    );

    // --- render ------------------------------------------------------------
    const showFilterBar = logs.length > 0;
    const isFilteredOut = logs.length > 0 && filteredLogs.length === 0;
    const totallyEmpty = logs.length === 0;

    return (
        <div className="h-full flex flex-col">
            {showFilterBar && (
                <FilterBar
                    filters={filters}
                    onChange={patchFilters}
                    onReset={resetFilters}
                    hostOptions={hostOptions}
                    dateFrom={filters.dateFrom}
                    dateTo={filters.dateTo}
                    hostFilter={effectiveHostFilter}
                    onDateFromChange={(dateFrom) => patchFilters({ dateFrom })}
                    onDateToChange={(dateTo) => patchFilters({ dateTo })}
                    onHostFilterChange={(hostFilter) => patchFilters({ hostFilter })}
                    userQuery={filters.userQuery}
                    userQueryOnChange={(userQuery) => patchFilters({ userQuery })}
                />
            )}

            {/* Results summary */}
            {showFilterBar && (
                <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground border-b border-border/20">
                    <span>{t("logs.filter.resultsCount", { count: filteredLogs.length })}</span>
                    {!isDefaultFilters(filters) && effectiveHostFilter !== filters.hostFilter && (
                        <span className="text-foreground/60">· {t("logs.filter.host")}: {effectiveHostFilter}</span>
                    )}
                </div>
            )}

            {/* Content */}
            <ScrollArea className="flex-1">
                <div>
                    {totallyEmpty ? (
                        <EmptyLogsState
                            title={t("logs.empty.title")}
                            desc={t("logs.empty.desc")}
                        />
                    ) : isFilteredOut ? (
                        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                            <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                                <Search size={32} className="opacity-60" />
                            </div>
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                                {t("logs.empty.filtered.title")}
                            </h3>
                            <p className="text-sm text-center max-w-sm mb-3">{t("logs.empty.filtered.desc")}</p>
                            <button
                                type="button"
                                onClick={resetFilters}
                                className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md bg-foreground/5 hover:bg-foreground/10 text-sm text-foreground transition-colors"
                            >
                                <RotateCcw size={14} />
                                {t("logs.filter.clear")}
                            </button>
                        </div>
                    ) : (
                        <>
                            {/* Table Header */}
                            <div className="flex items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30 bg-secondary/30 sticky top-0 z-10">
                                <div className="w-44 shrink-0 flex items-center gap-1">
                                    {t("logs.table.date")}
                                    <ChevronDown size={12} />
                                </div>
                                <div className="w-56 shrink-0">{t("logs.table.user")}</div>
                                <div className="flex-1">{t("logs.table.host")}</div>
                                <div className="w-20 shrink-0 flex items-center gap-1">
                                    {t("logs.table.saved")}
                                    <Bookmark size={12} />
                                </div>
                            </div>
                            {renderedItems}
                        </>
                    )}
                </div>
            </ScrollArea>

            {/* Pagination footer */}
            {showFilterBar && filteredLogs.length > 0 && (
                <Pagination
                    pageIndex={currentPage}
                    pageSize={pageSize}
                    totalCount={filteredLogs.length}
                    onPageChange={setPageIndex}
                    onPageSizeChange={(size) => {
                        setPageSize(size);
                        setPageIndex(0);
                    }}
                />
            )}
        </div>
    );
};

// Custom comparison
const logsManagerAreEqual = (
    prev: ConnectionLogsManagerProps,
    next: ConnectionLogsManagerProps,
): boolean => {
    return prev.logs === next.logs && prev.hosts === next.hosts;
};

export default memo(ConnectionLogsManager, logsManagerAreEqual);
