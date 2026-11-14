// A small, generic starter set of leave types, offered once on an empty Leave types list. It is a template for the
// owner to edit, not a statement of anyone's legal entitlement: it carries a code, a name and whether the leave is paid,
// and nothing else (no entitlement figure, and `accrual_rule` is left empty). Pure: no host, DOM or React.
// Columns mirror `leave_types` in app/storage/002-hr-records.json; tests keep them in step.
export interface StarterLeaveType { code: string; name: string; nameZh: string; paid: boolean }

export const STARTER_LEAVE_TYPES: readonly StarterLeaveType[] = [
  { code: "ANNUAL", name: "Annual leave", nameZh: "年假", paid: true },
  { code: "SICK", name: "Sick leave", nameZh: "病假", paid: true },
  { code: "UNPAID", name: "Unpaid leave", nameZh: "無薪假", paid: false },
  { code: "COMP", name: "Time off in lieu", nameZh: "補假", paid: true },
];

/** One starter row to create. The record id is fixed per code, so running the load again meets the rows it already made. */
export interface StarterItem { record_id: string; profile: { code: string; name: string; paid: boolean } }

export const starterRecordId = (code: string): string => `lt-starter-${code.toLowerCase()}`;

/** The rows for a locale, in list order. The locale chooses the stored name and nothing else. */
export function starterItems(locale: "en" | "zh-TW"): StarterItem[] {
  return STARTER_LEAVE_TYPES.map((row) => ({
    record_id: starterRecordId(row.code),
    profile: { code: row.code, name: locale === "zh-TW" ? row.nameZh : row.name, paid: row.paid },
  }));
}

/** What the loader needs from storage. The screen supplies the host calls; tests supply a fake. */
export interface StarterPort {
  /** Which of the starter codes are already stored, under whatever record id. A failed read throws. */
  existingCodes(): Promise<ReadonlySet<string>>;
  /** Create one row. Resolves `exists` when a leave type with that code is already stored. */
  create(item: StarterItem): Promise<"created" | "exists">;
}
export interface StarterResult { created: number; alreadyThere: number }

/**
 * Create the starter leave types one at a time. A code that is already stored is skipped, so existing leave types are
 * never touched and a load that stopped part-way continues from where it stopped when run again. A failed create
 * rejects; the rows created before it stay.
 */
export async function loadStarterLeaveTypes(
  port: StarterPort,
  locale: "en" | "zh-TW",
  onProgress?: (done: number, total: number) => void,
): Promise<StarterResult> {
  const existing = await port.existingCodes();
  const items = starterItems(locale);
  const result: StarterResult = { created: 0, alreadyThere: 0 };
  let done = 0;
  for (const item of items) {
    if (existing.has(item.profile.code) || (await port.create(item)) === "exists") result.alreadyThere += 1;
    else result.created += 1;
    done += 1;
    onProgress?.(done, items.length);
  }
  return result;
}
