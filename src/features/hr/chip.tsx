import { optionLabel } from "../../domain/records";

/** A stored status, stage or category as a chip; an unknown value is shown as it is. */
export const chip = (value: unknown, t: (s: string) => string) => {
  const v = typeof value === "string" && value !== "" ? value : null;
  return <span className="chip" data-status={v ?? "unknown"}>{t(optionLabel(v ?? ""))}</span>;
};
