// Synthetic people only: invented names, the reserved example.invalid domain, no real data.
export interface SeedRow { id: string; revision: number; profile: Record<string, string | null> }

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
