// 会谈预约与改期额度台：领域规则、数据模型与持久化

export type SessionFormat = "面谈" | "视频" | "电话";
export type AppointmentStatus = "待确认" | "已确认";
export type ChangeKind = "创建" | "改期" | "更正";

export interface AppointmentSnapshot {
  counselor: string;
  format: SessionFormat;
  start: string; // datetime-local：YYYY-MM-DDTHH:mm（本地时间）
  end: string;
}

export interface VersionEntry extends AppointmentSnapshot {
  version: number;
  kind: ChangeKind;
  at: string; // ISO 时间戳
  reason?: string; // 改期理由 / 冻结后更正原因
  supervisor?: string; // 额度用完后指定的督导
  charged?: boolean; // 是否计入当月改期次数
}

export interface Appointment extends AppointmentSnapshot {
  id: string;
  clientCode: string;
  status: AppointmentStatus;
  createdAt: string;
  versions: VersionEntry[];
}

// usage[来访者代号][YYYY-MM] = 当月已用改期次数
export type UsageMap = Record<string, Record<string, number>>;

export interface Store {
  appointments: Appointment[];
  seq: number;
  usage: UsageMap;
}

export interface DraftSlot {
  clientCode: string;
  counselor: string;
  start: string;
  end: string;
}

export interface BlockedView {
  clientCode: string;
  counselor: string;
  requestedSlot: string;
  rule: string;
  detail: string;
  conflictSlot?: string;
  conflictId?: string;
}

export const COUNSELORS = ["林清", "周岚", "陈屿", "高航"];
export const SUPERVISORS = ["赵督导", "孙督导"];
export const FORMATS: SessionFormat[] = ["面谈", "视频", "电话"];

export const FREE_RESHEDULES_PER_MONTH = 2;
export const CLIENT_BUFFER_MIN = 15;
const BUFFER_MS = CLIENT_BUFFER_MIN * 60 * 1000;

export const RULES = {
  required: "规则0 · 预约单须完整填写来访者代号、咨询师、形式和起止时刻",
  time: "规则0 · 结束时刻必须晚于开始时刻",
  counselor:
    "规则① · 咨询师时段唯一：同一咨询师同一时段只接受一场会谈",
  clientOverlap:
    "规则② · 来访者缓冲：同一来访者不得在同一时段参加两场会谈",
  clientBuffer:
    "规则② · 来访者缓冲：同一来访者相邻两场会谈之间须留足 15 分钟",
  quota:
    "规则④ · 改期额度：每月两次免费改期，用完后改期须指定督导并写理由，缺任一项时原时段继续占用、不释放给他人",
  frozen:
    "规则⑤ · 冻结更正：会谈确认后预约冻结，更正须另存为带原因的新版本",
};

const STORAGE_KEY = "hxwl-12-booking-v1";

// ---------- 时间工具 ----------

const ts = (value: string): number => new Date(value).getTime();

export function isValidRange(start: string, end: string): boolean {
  return !!start && !!end && ts(end) > ts(start);
}

function overlaps(a: DraftSlot, bStart: string, bEnd: string): boolean {
  return ts(a.start) < ts(bEnd) && ts(bStart) < ts(a.end);
}

type HitKind = "counselor" | "client-overlap" | "client-buffer";

export interface ConflictHit {
  kind: HitKind;
  rule: string;
  appointment: Appointment;
}

// 规则①：同一咨询师时段唯一；规则②：同一来访者 15 分钟缓冲
export function findConflicts(
  appointments: Appointment[],
  ignoreId: string | null,
  draft: DraftSlot
): ConflictHit[] {
  if (!isValidRange(draft.start, draft.end)) return [];
  const hits: ConflictHit[] = [];
  const s = ts(draft.start);
  const e = ts(draft.end);

  for (const appointment of appointments) {
    if (appointment.id === ignoreId) continue;
    const as = ts(appointment.start);
    const ae = ts(appointment.end);

    if (
      appointment.counselor === draft.counselor &&
      overlaps(draft, appointment.start, appointment.end)
    ) {
      hits.push({ kind: "counselor", rule: RULES.counselor, appointment });
    }

    if (appointment.clientCode === draft.clientCode) {
      const directOverlap = s < ae && as < e;
      const bufferOk = e + BUFFER_MS <= as || s >= ae + BUFFER_MS;
      if (directOverlap) {
        hits.push({
          kind: "client-overlap",
          rule: RULES.clientOverlap,
          appointment,
        });
      } else if (!bufferOk) {
        hits.push({
          kind: "client-buffer",
          rule: RULES.clientBuffer,
          appointment,
        });
      }
    }
  }
  return hits;
}

export function hitToBlocked(draft: DraftSlot, hit: ConflictHit): BlockedView {
  const other = hit.appointment;
  return {
    clientCode: draft.clientCode,
    counselor: draft.counselor,
    requestedSlot: formatRange(draft.start, draft.end),
    conflictSlot: formatRange(other.start, other.end),
    conflictId: other.id,
    rule: hit.rule,
    detail:
      hit.kind === "counselor"
        ? `咨询师 ${other.counselor} 在该时段已有会谈 ${other.id}（来访者 ${other.clientCode}）`
        : `来访者 ${other.clientCode} 的相邻会谈 ${other.id} 未满足 15 分钟缓冲`,
  };
}

// ---------- 改期额度（按操作发生的自然月） ----------

export function monthKey(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}`;
}

export function usedInMonth(
  usage: UsageMap,
  clientCode: string,
  key = monthKey()
): number {
  return usage[clientCode]?.[key] ?? 0;
}

export function remainingFree(
  usage: UsageMap,
  clientCode: string,
  key = monthKey()
): number {
  return Math.max(0, FREE_RESHEDULES_PER_MONTH - usedInMonth(usage, clientCode, key));
}

// ---------- 展示格式 ----------

const WEEK = "日一二三四五六";

function parts(value: string) {
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return { d, p };
}

export function formatDay(value: string): string {
  const { d, p } = parts(value);
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} 周${WEEK[d.getDay()]}`;
}

export function formatTime(value: string): string {
  const { d, p } = parts(value);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatRange(start: string, end: string): string {
  if (!start && !end) return "（未填写时段）";
  if (!start || !end) return `${formatDay(start || end)} ${start ? formatTime(start) + " 起" : "至 " + formatTime(end)}`;
  return `${formatDay(start)} ${formatTime(start)}–${formatTime(end)}`;
}

export function formatStamp(iso: string): string {
  const { d, p } = parts(iso);
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 持久化 ----------

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      if (Array.isArray(parsed.appointments) && typeof parsed.seq === "number") {
        return parsed;
      }
    }
  } catch {
    // 数据损坏时回落到示例数据
  }
  return seedStore();
}

export function saveStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 隐私模式等场景下静默降级为内存态
  }
}

export function resetStore(): Store {
  const seeded = seedStore();
  saveStore(seeded);
  return seeded;
}

// ---------- 示例数据 ----------

function localDateTime(offsetDays: number, hh: number, mm: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hh, mm, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`;
}

export function seedStore(): Store {
  const now = new Date().toISOString();
  const v1 = (s: AppointmentSnapshot): VersionEntry => ({
    ...s,
    version: 1,
    kind: "创建",
    at: now,
  });

  const a1Start = localDateTime(0, 10, 0);
  const a1End = localDateTime(0, 11, 0);
  const a2Start = localDateTime(0, 14, 0);
  const a2End = localDateTime(0, 14, 50);
  const a3Start = localDateTime(0, 16, 0);
  const a3End = localDateTime(0, 16, 45);
  // C-042 明天的会谈曾改期一次，用来演示版本链与额度
  const a4OldStart = localDateTime(1, 11, 0);
  const a4OldEnd = localDateTime(1, 12, 0);
  const a4Start = localDateTime(1, 9, 30);
  const a4End = localDateTime(1, 10, 30);

  const appointments: Appointment[] = [
    {
      id: "A-0001",
      clientCode: "C-042",
      counselor: "林清",
      format: "面谈",
      start: a1Start,
      end: a1End,
      status: "已确认",
      createdAt: now,
      versions: [v1({ counselor: "林清", format: "面谈", start: a1Start, end: a1End })],
    },
    {
      id: "A-0002",
      clientCode: "C-119",
      counselor: "周岚",
      format: "视频",
      start: a2Start,
      end: a2End,
      status: "待确认",
      createdAt: now,
      versions: [v1({ counselor: "周岚", format: "视频", start: a2Start, end: a2End })],
    },
    {
      id: "A-0003",
      clientCode: "C-203",
      counselor: "陈屿",
      format: "电话",
      start: a3Start,
      end: a3End,
      status: "待确认",
      createdAt: now,
      versions: [v1({ counselor: "陈屿", format: "电话", start: a3Start, end: a3End })],
    },
    {
      id: "A-0004",
      clientCode: "C-042",
      counselor: "高航",
      format: "视频",
      start: a4Start,
      end: a4End,
      status: "待确认",
      createdAt: now,
      versions: [
        v1({ counselor: "高航", format: "视频", start: a4OldStart, end: a4OldEnd }),
        {
          version: 2,
          kind: "改期",
          at: now,
          counselor: "高航",
          format: "视频",
          start: a4Start,
          end: a4End,
          reason: "来访者上午课程调整",
          charged: true,
        },
      ],
    },
  ];

  return {
    appointments,
    seq: 5,
    usage: { "C-042": { [monthKey()]: 1 } },
  };
}
