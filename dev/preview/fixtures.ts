// Synthetic people only: invented names, the reserved example.invalid domain, no real data.
export interface SeedRow { id: string; revision: number; profile: Record<string, string | number | boolean | object | null> }

const NAMES: [string, string, string][] = [
  ["Avery Sample", "Operations", "Operations Lead"], ["Blake Sample", "Finance", "Accountant"], ["Casey Sample", "Finance", "Finance Analyst"],
  ["Devon Sample", "Engineering", "Software Engineer"], ["Emery Sample", "Engineering", "Engineering Manager"], ["Frankie Sample", "People", "HR Officer"],
  ["Gray Sample", "Sales", "Account Executive"], ["Harper Sample", "Sales", "Sales Coordinator"], ["Indigo Sample", "Support", "Support Specialist"],
  ["Jules Sample", "Support", "Support Lead"], ["Kai Sample", "Operations", "Logistics Coordinator"], ["Logan Sample", "Engineering", "QA Engineer"],
  ["Morgan Sample", "People", "Recruiter"], ["Noa Sample", "Marketing", "Content Writer"], ["Oakley Sample", "Marketing", "Designer"],
  ["Parker Sample", "Finance", "Payables Clerk"], ["Quinn Sample", "Sales", "Regional Manager"], ["Reese Sample", "Support", "Support Specialist"],
  ["Sage Sample", "Operations", "Warehouse Supervisor"], ["Tatum Sample", "Engineering", "Data Engineer"], ["陳大文", "營運部", "營運主任"],
  ["張小明", "客戶服務部", "客戶服務專員"], ["Umber Sample", "Marketing", "Marketing Manager"], ["Vale Sample", "Engineering", "Intern"],
  ["Wren Sample", "Operations", "Part-time Driver"], ["Xen Sample", "Finance", "Contract Auditor"],
];
const TYPES = ["full_time"];

export function seedRows(): SeedRow[] {
  return NAMES.map(([name, department, title], i) => {
    const n = String(i + 1).padStart(3, "0");
    const left = i % 9 === 8;
    return {
      id: `emp-seed${n}`, revision: 1,
      profile: {
        display_name: name, employee_no: `E-${n}`, email: i % 5 === 4 ? null : `person${n}@example.invalid`, phone: i % 3 === 0 ? `+852 5550 ${String(1000 + i)}` : null,
        job_title: title, department, employment_type: title === "Intern" ? "intern" : title.startsWith("Part-time") ? "part_time" : title.startsWith("Contract") ? "contract" : TYPES[i % TYPES.length]!,
        join_date: `20${String(18 + (i % 8)).padStart(2, "0")}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`,
        leave_date: left ? "2026-09-30" : null, manager_id: i % 4 === 0 ? null : "emp-seed001", status: left ? "left" : i % 11 === 10 ? "on_leave" : "active", member_id: null,
      },
    };
  });
}

// Synthetic rows for the 0.2.0 tables. Invented people, the reserved example.invalid domain, no real policy text.
export function seedTables(): Record<string, SeedRow[]> {
  const emp = seedRows();
  const row = (id: string, profile: Record<string, string | number | boolean | null | object>): SeedRow => ({ id, revision: 1, profile: profile as SeedRow["profile"] });
  const who = (i: number) => ({ employee_id: emp[i]!.id, employee_name: String(emp[i]!.profile.display_name) });
  return {
    policies: [
      row("pol-001", { title: "Annual leave (sample)", category: "leave", language: "en", effective_from: "2026-01-01", status: "current", body: "Sample policy text. Staff receive an invented number of days each year." }),
      row("pol-002", { title: "Meal claims (sample)", category: "claims", language: "en", effective_from: "2026-03-01", status: "current", body: "Sample text. Meals are claimed with a receipt within an invented period." }),
      row("pol-003", { title: "年假（樣本）", category: "leave", language: "zh-HK", effective_from: "2025-01-01", status: "retired", body: "樣本政策內容，只供預覽。" }),
    ],
    leave_types: [row("lt-001", { code: "ANNUAL", name: "Annual leave", paid: true, accrual_rule: null }), row("lt-002", { code: "UNPAID", name: "Unpaid leave", paid: false, accrual_rule: null })],
    leave_requests: [
      row("lv-001", { ...who(0), leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 4, reason: "", status: "pending", decided_on: null, decision_note: null }),
      row("lv-002", { ...who(1), leave_type: "UNPAID", start_date: "2026-04-10", end_date: "2026-04-10", half_days: 1, reason: "Personal", status: "pending", decided_on: null, decision_note: null }),
      row("lv-003", { ...who(2), leave_type: "ANNUAL", start_date: "2026-02-02", end_date: "2026-02-06", half_days: 10, reason: "", status: "approved", decided_on: "2026-01-20", decision_note: null }),
    ],
    claims: [
      row("cl-001", { ...who(3), claim_date: "2026-03-02", category: "meals", merchant: "Sample Cafe", amount_minor: 1250, currency: "HKD", description: "Team lunch", receipt_ref: null, status: "submitted", decided_on: null, decision_note: null }),
      row("cl-002", { ...who(4), claim_date: "2026-02-20", category: "travel", merchant: "Sample Transit", amount_minor: 4800, currency: "HKD", description: "", receipt_ref: "receipt-1.pdf", status: "approved", decided_on: "2026-02-22", decision_note: null }),
    ],
    job_openings: [row("job-001", { title: "Sample Bookkeeper", department: "Finance", description: "Keep the books. Invented requirements for preview.", status: "open" }), row("job-002", { title: "Sample Designer", department: "Marketing", description: "", status: "draft" })],
    candidates: [
      row("cand-001", { opening_id: "job-001", display_name: "Robin Sample", email: "robin@example.invalid", phone: null, source: "Referral", stage: "new", cv_text: "Sample CV text, invented.", screening: { summary: "Evidences 1 of 2 requirements.", reasons: ["Requirement: bookkeeping. CV: 'bookkeeping experience' (evidenced).", "Requirement: payroll. Not mentioned (ask at interview)."] } }),
      row("cand-002", { opening_id: "job-001", display_name: "Sasha Sample", email: null, phone: null, source: "", stage: "interview", cv_text: "", screening: null }),
    ],
  };
}
