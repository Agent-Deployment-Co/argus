import { Banknote, ClipboardList, Coins, MessageSquareText, MessagesSquare, ScrollText, type LucideIcon } from "lucide-react";

// Canonical metric icons — the single source of truth for how each session metric is depicted, so
// tokens / interactions / tasks look identical everywhere they appear (session list, overview cards,
// timeline chapter headers, per-task timeline links). Reference these instead of picking a lucide
// icon directly for one of these concepts, so the convention stays consistent.
export const SessionIcon: LucideIcon = MessageSquareText;
export const TokensIcon: LucideIcon = Coins;
export const InteractionsIcon: LucideIcon = MessagesSquare;
export const TasksIcon: LucideIcon = ClipboardList;
export const SkillIcon: LucideIcon = ScrollText;
// Estimated cost (the tokens/cost mode toggle on the Home usage hero). Banknote is the canonical
// "money / spend" mark, kept here so cost reads the same wherever it's depicted.
export const CostIcon: LucideIcon = Banknote;
