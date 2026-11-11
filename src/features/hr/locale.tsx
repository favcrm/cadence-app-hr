import { LocaleTextProvider } from "@cadence/screen-ui";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { zhHK } from "./localeCatalog";

// The host pushes `en` or `zh-TW` (its only Chinese value); the catalog behind
// `zh-TW` is written in Hong Kong usage, which is the written zh-HK this app ships.
type Locale = "en" | "zh-TW";
type LocaleValue = { t: (english: string) => string; formatNumber: (value: number) => string; formatDate: (ms: number, options?: Intl.DateTimeFormatOptions) => string };
const identity = (english: string) => english;
const LocaleContext = createContext<LocaleValue>({ t: identity, formatNumber: (n) => new Intl.NumberFormat("en").format(n), formatDate: (ms, o) => new Intl.DateTimeFormat("en", o).format(ms) });

/** Host-selected display data only. No preferences, session or authority access. */
export function HrLocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<LocaleValue>(() => ({
    t: locale === "zh-TW" ? (english) => zhHK[english] ?? english : identity,
    formatNumber: (n) => new Intl.NumberFormat(locale === "zh-TW" ? "zh-HK" : "en").format(n),
    formatDate: (ms, o) => new Intl.DateTimeFormat(locale === "zh-TW" ? "zh-HK" : "en", o).format(ms),
  }), [locale]);
  return <LocaleContext.Provider value={value}><LocaleTextProvider value={value.t}>{children}</LocaleTextProvider></LocaleContext.Provider>;
}
export const useLocale = () => useContext(LocaleContext);
