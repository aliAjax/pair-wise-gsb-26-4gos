// 会谈预约与改期额度的领域逻辑：冲突规则、改期额度、版本与本地持久化

export const BUFFER_MINUTES = 15;
export const FREE_RESCHEDULES_PER_MONTH = 2;

export const COUNSELORS = ["林晓", "周谨", "吴岚"];
export const SUPERVISORS = ["沈默", "顾言"];
export const FORMATS = ["面询", "视频", "语音"];

export const RULES = {
  counselorOverlap: "同一咨询师同一时段只接受一场会谈",
  clientBuffer: `同一来访者相邻两场会谈之间须留 ${BUFFER_MINUTES} 分钟缓冲`,
  rescheduleQuota: `每位来访者每月 ${FREE_RESCHEDULES_PER_MONTH} 次免费改期，用完后须指定督导并填写理由`,
  frozen: "会谈确认后预约冻结，更正须另存带原因的新版本",
};

export interface Slot {
  start: string; // datetime-local 格式 "YYYY-MM-DDTHH:MM"
  end: string;
}

export interface VersionRecord {
  version: number;
  at: string;
  reason: string;
  snapshot: {
    clientCode: string;
    counselor: string;
    format: string;
    start: string;
    end: string;
  };
}

export interface Appointment {
  id: string;
  clientCode: string;
  counselor: string;
  format: string;
  start: string;
  end: string;
  status: "booked" | "confirmed";
  createdAt: string;
  confirmedAt: string | null;
  versions: VersionRecord[];
}

export interface RescheduleRecord {
  id: string;
  appointmentId: string;
  clientCode: string;
  counselor: string;
  month: string; // 计费月份（原时段所在月）YYYY-MM
  from: Slot;
  to: Slot;
  supervisor: string | null;
  reason: string | null;
  usedFreeQuota: boolean;
  at: string;
}

export interface SchedulerState {
  appointments: Appointment[];
  reschedules: RescheduleRecord[];
}

export interface ConflictHit {
  rule: string;
  appointment: Appointment;
}

export interface BlockedReport {
  anchor: string; // "booking" 或预约 id，决定报告渲染位置
  action: string;
  kind: "conflict" | "quota" | "invalid";
  clientCode: string;
  counselor: string;
  slotLabel: string;
  hits: ConflictHit[];
  message?: string;
}

// ---------- 时间工具 ----------

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toMs(iso: string): number {
  return new Date(iso).getTime();
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtSlot(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameDay = s.toDateString() === e.toDateString();
  const endLabel = sameDay ? `${pad(e.getHours())}:${pad(e.getMinutes())}` : fmtDateTime(end);
  return `${fmtDateTime(start)} – ${endLabel}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------- 冲突规则 ----------

export function findConflicts(
  appointments: Appointment[],
  candidate: { clientCode: string; counselor: string; start: string; end: string },
  excludeId?: string
): ConflictHit[] {
  const s = toMs(candidate.start);
  const e = toMs(candidate.end);
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  const hits: ConflictHit[] = [];

  for (const a of appointments) {
    if (excludeId && a.id === excludeId) continue;
    const as = toMs(a.start);
    const ae = toMs(a.end);

    // 规则一：同一咨询师时段互斥（区间相交）
    if (a.counselor === candidate.counselor && s < ae && as < e) {
      hits.push({ rule: RULES.counselorOverlap, appointment: a });
    }
    // 规则二：同一来访者相邻两场之间留 15 分钟缓冲（含重叠）
    if (a.clientCode === candidate.clientCode && s < ae + bufferMs && as < e + bufferMs) {
      hits.push({ rule: RULES.clientBuffer, appointment: a });
    }
  }
  return hits;
}

// ---------- 改期额度 ----------

export function reschedulesUsed(reschedules: RescheduleRecord[], clientCode: string, month: string): number {
  return reschedules.filter((r) => r.clientCode === clientCode && r.month === month).length;
}

export function freeRemaining(reschedules: RescheduleRecord[], clientCode: string, month: string): number {
  return Math.max(0, FREE_RESCHEDULES_PER_MONTH - reschedulesUsed(reschedules, clientCode, month));
}

// ---------- 版本 ----------

export function snapshotOf(a: Appointment) {
  return {
    clientCode: a.clientCode,
    counselor: a.counselor,
    format: a.format,
    start: a.start,
    end: a.end,
  };
}

// ---------- 持久化 ----------

const STORAGE_KEY = "hxwl-12-scheduler-v1";

export function loadState(): SchedulerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SchedulerState;
      if (Array.isArray(parsed.appointments) && Array.isArray(parsed.reschedules)) return parsed;
    }
  } catch {
    // 存储不可用时退回种子数据
  }
  return seedState();
}

export function saveState(state: SchedulerState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 忽略写入失败（如隐私模式）
  }
}

// ---------- 种子数据（相对今天生成，保证演示可用） ----------

function seedState(): SchedulerState {
  const now = new Date();
  const at = (dayOffset: number, h: number, m: number) =>
    toLocalInputValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m));
  const stamp = toLocalInputValue(now);

  const mk = (
    id: string,
    clientCode: string,
    counselor: string,
    format: string,
    start: string,
    end: string,
    status: Appointment["status"]
  ): Appointment => {
    const base = { id, clientCode, counselor, format, start, end, status, createdAt: stamp, confirmedAt: status === "confirmed" ? stamp : null };
    return {
      ...base,
      versions: [{ version: 1, at: stamp, reason: "创建预约", snapshot: snapshotOf(base as Appointment) }],
    };
  };

  const a1 = mk("seed-a1", "C-042", "林晓", "面询", at(0, 9, 0), at(0, 9, 50), "confirmed");
  const a2 = mk("seed-a2", "C-119", "林晓", "视频", at(0, 10, 30), at(0, 11, 20), "booked");
  const a3 = mk("seed-a3", "C-042", "周谨", "语音", at(0, 14, 0), at(0, 14, 50), "booked");
  const a4 = mk("seed-a4", "C-203", "吴岚", "面询", at(1, 11, 0), at(1, 11, 50), "confirmed");

  const reschedules: RescheduleRecord[] = [
    {
      id: "seed-r1",
      appointmentId: a1.id,
      clientCode: a1.clientCode,
      counselor: a1.counselor,
      month: monthOf(a1.start),
      from: { start: at(0, 8, 0), end: at(0, 8, 50) },
      to: { start: a1.start, end: a1.end },
      supervisor: null,
      reason: null,
      usedFreeQuota: true,
      at: stamp,
    },
  ];

  return { appointments: [a1, a2, a3, a4], reschedules };
}
