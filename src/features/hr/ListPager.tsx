import { Button } from "@cadence/screen-ui";
import { useLocale } from "./locale";

export const LIST_PAGE_SIZE = 20;

/** Presentation only: the list owns the cursor chain. */
export default function ListPager({ page, pageCount, summary, onPrevious, onNext, hasNext, busy }: {
  page: number; pageCount: number | null; summary: string; onPrevious: () => void; onNext: () => void; hasNext: boolean; busy: boolean;
}) {
  const { t, formatNumber } = useLocale();
  const label = pageCount === null
    ? t("Page {page}").replace("{page}", formatNumber(page + 1))
    : t("Page {page} of {total}").replace("{page}", formatNumber(page + 1)).replace("{total}", formatNumber(pageCount));
  return (
    <div className="hr-pager">
      <span className="text-label text-ink-400" aria-live="polite">{summary}</span>
      <div className="hr-page-controls">
        <Button disabled={page === 0 || busy} onClick={onPrevious}>← {t("Previous")}</Button>
        <span className="text-label text-ink-300" aria-label={t("List page")}>{label}</span>
        <Button disabled={!hasNext || busy} onClick={onNext}>{t("Next")} →</Button>
      </div>
    </div>
  );
}
