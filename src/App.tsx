import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  Appointment,
  BlockedView,
  ChangeKind,
  COUNSELORS,
  FORMATS,
  FREE_RESHEDULES_PER_MONTH,
  RULES,
  SUPERVISORS,
  SessionFormat,
  Store,
  hitToBlocked,
  findConflicts,
  formatRange,
  formatStamp,
  isValidRange,
  loadStore,
  monthKey,
  remainingFree,
  resetStore,
  saveStore,
  usedInMonth,
} from "./domain";

interface CreateForm {
  clientCode: string;
  counselor: string;
  format: SessionFormat | "";
  start: string;
  end: string;
}

const emptyCreate: CreateForm = {
  clientCode: "",
  counselor: "",
  format: "",
  start: "",
  end: "",
};

type EditMode = "reschedule" | "correct";

interface EditForm {
  mode: EditMode;
  counselor: string;
  format: SessionFormat;
  start: string;
  end: string;
  supervisor: string;
  reason: string;
}

interface Flash {
  kind: "ok" | "err";
  text: string;
  blocked?: BlockedView[];
}

const nextId = (store: Store) => `A-${String(store.seq).padStart(4, "0")}`;

function App() {
  const [store, setStore] = useState<Store>(() => loadStore());
  const [form, setForm] = useState<CreateForm>(emptyCreate);
  const [createBlocked, setCreateBlocked] = useState<BlockedView[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditForm | null>(null);
  const [editBlocked, setEditBlocked] = useState<BlockedView[]>([]);
  const [filter, setFilter] = useState<"all" | "待确认" | "已确认">("all");

  // 刷新后预约、改期额度与版本保持一致
  useEffect(() => {
    saveStore(store);
  }, [store]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const currentMonth = monthKey();
  const clients = useMemo(() => {
    const set = new Set<string>();
    store.appointments.forEach((a) => set.add(a.clientCode));
    Object.keys(store.usage).forEach((c) => set.add(c));
    return Array.from(set).sort();
  }, [store]);

  const stats = useMemo(() => {
    const pending = store.appointments.filter((a) => a.status === "待确认").length;
    const confirmed = store.appointments.length - pending;
    return { total: store.appointments.length, pending, confirmed };
  }, [store]);

  const sortedAppointments = useMemo(
    () =>
      [...store.appointments]
        .filter((a) => filter === "all" || a.status === filter)
        .sort((a, b) => a.start.localeCompare(b.start)),
    [store.appointments, filter]
  );

  // ---------- 创建预约 ----------

  const updateForm = (patch: Partial<CreateForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setCreateBlocked([]);
  };

  const submitCreate = () => {
    const blocked: BlockedView[] = [];
    if (
      !form.clientCode.trim() ||
      !form.counselor ||
      !form.format ||
      !form.start ||
      !form.end
    ) {
      blocked.push({
        clientCode: form.clientCode.trim() || "（来访者代号未填）",
        counselor: form.counselor || "（咨询师未选）",
        requestedSlot: formatRange(form.start, form.end),
        rule: RULES.required,
        detail: "必填项缺失，预约单不成立，已保留已填内容。",
      });
    } else if (!isValidRange(form.start, form.end)) {
      blocked.push({
        clientCode: form.clientCode.trim(),
        counselor: form.counselor,
        requestedSlot: formatRange(form.start, form.end),
        rule: RULES.time,
        detail: "结束时刻必须晚于开始时刻，已保留已填内容。",
      });
    }

    if (blocked.length === 0) {
      const draft = {
        clientCode: form.clientCode.trim(),
        counselor: form.counselor,
        start: form.start,
        end: form.end,
      };
      findConflicts(store.appointments, null, draft).forEach((hit) =>
        blocked.push(hitToBlocked(draft, hit))
      );
    }

    // 相撞时保留已填内容并指出冲突预约
    if (blocked.length > 0) {
      setCreateBlocked(blocked);
      setFlash({
        kind: "err",
        text: "预约被规则拦截，表单内容已保留，请调整后重试。",
        blocked,
      });
      return;
    }

    const id = nextId(store);
    const snapshot = {
      counselor: form.counselor,
      format: form.format as SessionFormat,
      start: form.start,
      end: form.end,
    };
    const now = new Date().toISOString();
    const appointment: Appointment = {
      id,
      clientCode: form.clientCode.trim(),
      status: "待确认",
      createdAt: now,
      ...snapshot,
      versions: [{ ...snapshot, version: 1, kind: "创建", at: now }],
    };

    setStore({ ...store, appointments: [...store.appointments, appointment], seq: store.seq + 1 });
    setForm(emptyCreate);
    setCreateBlocked([]);
    setFlash({
      kind: "ok",
      text: `预约 ${id} 已创建（待确认），时段 ${formatRange(form.start, form.end)} 已占用。`,
    });
  };

  // ---------- 确认 / 撤销 ----------

  const confirmAppointment = (id: string) => {
    setStore({
      ...store,
      appointments: store.appointments.map((a) =>
        a.id === id ? { ...a, status: "已确认" } : a
      ),
    });
    setFlash({ kind: "ok", text: `会谈 ${id} 已确认，预约随即冻结；后续更正将另存带原因的新版本。` });
  };

  const withdraw = (id: string) => {
    setStore({ ...store, appointments: store.appointments.filter((a) => a.id !== id) });
    setFlash({ kind: "ok", text: `待确认预约 ${id} 已撤销，其占用时段已释放给他人。` });
  };

  // ---------- 改期 / 更正 ----------

  const startEdit = (appointment: Appointment, mode: EditMode) => {
    setEditingId(appointment.id);
    setEditBlocked([]);
    setEdit({
      mode,
      counselor: appointment.counselor,
      format: appointment.format,
      start: appointment.start,
      end: appointment.end,
      supervisor: "",
      reason: "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEdit(null);
    setEditBlocked([]);
  };

  const submitEdit = (appointment: Appointment) => {
    if (!edit) return;
    const isReschedule = edit.mode === "reschedule";
    const timeChanged = edit.start !== appointment.start || edit.end !== appointment.end;

    // 改期改的是时段；更正是冻结后对已确认单的留痕修改
    const draft = {
      clientCode: appointment.clientCode,
      counselor: edit.counselor,
      start: edit.start,
      end: edit.end,
    };

    const blocked: BlockedView[] = [];

    if (!isValidRange(edit.start, edit.end)) {
      blocked.push({
        clientCode: appointment.clientCode,
        counselor: edit.counselor,
        requestedSlot: formatRange(edit.start, edit.end),
        rule: RULES.time,
        detail: "结束时刻必须晚于开始时刻，原时段继续占用。",
      });
    } else {
      findConflicts(store.appointments, appointment.id, draft).forEach((hit) =>
        blocked.push(hitToBlocked(draft, hit))
      );
    }

    const needsQuota = isReschedule || timeChanged;
    const outOfQuota =
      needsQuota && remainingFree(store.usage, appointment.clientCode, currentMonth) <= 0;

    // 额度用完：督导与理由缺一不可；缺任一项时原时段继续占用
    if (outOfQuota && (!edit.supervisor || !edit.reason.trim())) {
      blocked.push({
        clientCode: appointment.clientCode,
        counselor: edit.counselor,
        requestedSlot: formatRange(edit.start, edit.end),
        conflictSlot: formatRange(appointment.start, appointment.end),
        conflictId: appointment.id,
        rule: RULES.quota,
        detail:
          "本月两次免费改期已用完，改期须同时指定督导并写理由；当前" +
          `${edit.supervisor ? "督导已指定、理由缺失" : edit.reason.trim() ? "理由已填写、督导缺失" : "督导与理由均缺失"}，原时段不释放。`,
      });
    }

    // 冻结后任何更正都必须带原因
    if (
      appointment.status === "已确认" &&
      !isReschedule &&
      !edit.reason.trim()
    ) {
      blocked.push({
        clientCode: appointment.clientCode,
        counselor: edit.counselor,
        requestedSlot: formatRange(edit.start, edit.end),
        conflictSlot: formatRange(appointment.start, appointment.end),
        conflictId: appointment.id,
        rule: RULES.frozen,
        detail: "会谈已确认、预约冻结，更正必须写明原因并另存新版本。",
      });
    }

    if (blocked.length > 0) {
      setEditBlocked(blocked);
      setFlash({
        kind: "err",
        text: `${isReschedule ? "改期" : "更正"}被拦截，原时段 ${formatRange(appointment.start, appointment.end)} 继续占用、不释放给他人。`,
        blocked,
      });
      return;
    }

    const now = new Date().toISOString();
    const kind: ChangeKind = isReschedule ? "改期" : "更正";
    const charge = needsQuota;
    const snapshot = {
      counselor: edit.counselor,
      format: edit.format,
      start: edit.start,
      end: edit.end,
    };
    const updated: Appointment = {
      ...appointment,
      ...snapshot,
      versions: [
        ...appointment.versions,
        {
          ...snapshot,
          version: appointment.versions.length + 1,
          kind,
          at: now,
          reason: edit.reason.trim() || undefined,
          supervisor: outOfQuota ? edit.supervisor : undefined,
          charged: charge || undefined,
        },
      ],
    };

    const usage = { ...store.usage };
    if (charge) {
      const row = { ...(usage[appointment.clientCode] ?? {}) };
      row[currentMonth] = usedInMonth(store.usage, appointment.clientCode, currentMonth) + 1;
      usage[appointment.clientCode] = row;
    }

    setStore({ ...store, appointments: store.appointments.map((a) => (a.id === appointment.id ? updated : a)), usage });
    cancelEdit();
    setFlash({
      kind: "ok",
      text: charge
        ? `${kind}成功，新版本 v${updated.versions.length} 已存档；${appointment.clientCode} 本月还剩 ${remainingFree(
            usage,
            appointment.clientCode,
            currentMonth
          )} 次免费改期。`
        : `${kind}成功，新版本 v${updated.versions.length} 已存档，未占用改期额度。`,
    });
  };

  const handleReset = () => {
    if (!window.confirm("恢复示例数据将清除当前全部预约、额度与版本，确定继续？")) return;
    const seeded = resetStore();
    setStore(seeded);
    setForm(emptyCreate);
    setCreateBlocked([]);
    cancelEdit();
    setFlash({ kind: "ok", text: "已恢复示例数据。" });
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-12 · 会谈预约与改期额度台</p>
          <h1>会谈预约与改期额度台</h1>
          <p className="subtitle">
            预约单登记、咨询师时段互斥、来访者 15 分钟缓冲、每月两次免费改期额度、确认冻结与更正版本留痕；
            规则拦截时保留已填内容并指出冲突预约，数据刷新后保持一致。
          </p>
        </div>
        <div className="stack-card">
          <span>规则速览</span>
          <strong>① 咨询师同时段唯一</strong>
          <strong>② 来访者相邻间隔 15 分钟</strong>
          <strong>③ 每月 {FREE_RESHEDULES_PER_MONTH} 次免费改期</strong>
          <strong>④ 超额改期须督导＋理由</strong>
          <strong>⑤ 确认即冻结，更正另存版本</strong>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="预约总数" value={String(stats.total)} tone="primary" />
        <MetricCard label="待确认" value={String(stats.pending)} tone="watch" />
        <MetricCard label="已确认（冻结）" value={String(stats.confirmed)} tone="ok" />
        <MetricCard label={`本月（${currentMonth}）来访者`} value={`${clients.length} 位`} tone="accent" />
      </section>

      {flash && (
        <section className={`flash flash-${flash.kind}`}>
          <p>{flash.text}</p>
          {flash.blocked && flash.blocked.length > 0 && (
            <BlockedList blocked={flash.blocked} />
          )}
        </section>
      )}

      <section className="workspace">
        <aside className="panel narrow">
          <div className="section-heading">
            <div>
              <p>额度台账</p>
              <h2>本月改期额度</h2>
            </div>
          </div>
          <p className="hint">统计月份：{currentMonth}，每位来访者每月 {FREE_RESHEDULES_PER_MONTH} 次免费改期</p>
          <div className="quota-list">
            {clients.map((code) => {
              const used = usedInMonth(store.usage, code, currentMonth);
              const left = remainingFree(store.usage, code, currentMonth);
              return (
                <div key={code} className={`quota-row ${left === 0 ? "exhausted" : ""}`}>
                  <strong>{code}</strong>
                  <span>
                    已用 {used} / {FREE_RESHEDULES_PER_MONTH}
                  </span>
                  <em>{left > 0 ? `剩 ${left} 次免费` : "已用完 · 需督导"}</em>
                </div>
              );
            })}
          </div>

          <h2>人员</h2>
          <p className="hint">咨询师</p>
          <div className="chips">
            {COUNSELORS.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <p className="hint">督导（超额改期时指定）</p>
          <div className="chips muted">
            {SUPERVISORS.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>

          <h2>数据</h2>
          <button onClick={handleReset}>恢复示例数据</button>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>预约单</p>
              <h2>新建预约</h2>
            </div>
            <button className="primary-action" onClick={submitCreate}>
              提交预约
            </button>
          </div>
          <div className="field-grid">
            <label>
              <span>来访者代号 *</span>
              <input
                placeholder="如 C-042"
                value={form.clientCode}
                onChange={(e) => updateForm({ clientCode: e.target.value })}
              />
            </label>
            <label>
              <span>咨询师 *</span>
              <select value={form.counselor} onChange={(e) => updateForm({ counselor: e.target.value })}>
                <option value="">请选择咨询师</option>
                {COUNSELORS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>形式 *</span>
              <select
                value={form.format}
                onChange={(e) => updateForm({ format: e.target.value as SessionFormat | "" })}
              >
                <option value="">请选择形式</option>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-placeholder">
              <span>冲突规则</span>
              <div className="rule-box">同一咨询师时段唯一；同一来访者间隔 ≥ 15 分钟</div>
            </label>
            <label>
              <span>开始时刻 *</span>
              <input
                type="datetime-local"
                value={form.start}
                onChange={(e) => updateForm({ start: e.target.value })}
              />
            </label>
            <label>
              <span>结束时刻 *</span>
              <input
                type="datetime-local"
                value={form.end}
                onChange={(e) => updateForm({ end: e.target.value })}
              />
            </label>
          </div>
          {createBlocked.length > 0 && (
            <div className="blocked-inline">
              <BlockedList blocked={createBlocked} />
            </div>
          )}
        </section>
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>预约与版本</p>
            <h2>预约单列表</h2>
          </div>
          <div className="filter-tabs">
            {(["all", "待确认", "已确认"] as const).map((key) => (
              <button
                key={key}
                className={filter === key ? "tab active" : "tab"}
                onClick={() => setFilter(key)}
              >
                {key === "all" ? "全部" : key}
              </button>
            ))}
          </div>
        </div>
        <div className="record-list">
          {sortedAppointments.length === 0 && <p className="hint">当前筛选下没有预约单。</p>}
          {sortedAppointments.map((appointment) => (
            <AppointmentCard
              key={appointment.id}
              appointment={appointment}
              usage={store.usage}
              month={currentMonth}
              editing={editingId === appointment.id}
              edit={editingId === appointment.id ? edit : null}
              editBlocked={editingId === appointment.id ? editBlocked : []}
              onEdit={setEdit}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSubmitEdit={submitEdit}
              onConfirm={confirmAppointment}
              onWithdraw={withdraw}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "primary" | "watch" | "ok" | "accent";
}) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={`status-${tone}`} />
    </article>
  );
}

function BlockedList({ blocked }: { blocked: BlockedView[] }) {
  return (
    <div className="blocked-list">
      <p className="blocked-title">受阻明细（来访者 · 咨询师 · 冲突时段 · 命中规则）</p>
      {blocked.map((b, i) => (
        <div key={i} className="blocked-item">
          <div className="blocked-head">
            <span className="tag-client">{b.clientCode}</span>
            <span className="tag-counselor">{b.counselor}</span>
          </div>
          <dl>
            <dt>申请时段</dt>
            <dd>{b.requestedSlot}</dd>
            {b.conflictSlot && (
              <>
                <dt>{b.conflictId ? `冲突预约 ${b.conflictId}` : "当前占用时段"}</dt>
                <dd>{b.conflictSlot}</dd>
              </>
            )}
            <dt>命中规则</dt>
            <dd className="rule-hit">{b.rule}</dd>
            <dt>说明</dt>
            <dd>{b.detail}</dd>
          </dl>
        </div>
      ))}
    </div>
  );
}

function AppointmentCard({
  appointment,
  usage,
  month,
  editing,
  edit,
  editBlocked,
  onEdit,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onConfirm,
  onWithdraw,
}: {
  appointment: Appointment;
  usage: Store["usage"];
  month: string;
  editing: boolean;
  edit: EditForm | null;
  editBlocked: BlockedView[];
  onEdit: (form: EditForm) => void;
  onStartEdit: (a: Appointment, mode: EditMode) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (a: Appointment) => void;
  onConfirm: (id: string) => void;
  onWithdraw: (id: string) => void;
}) {
  const frozen = appointment.status === "已确认";
  const used = usedInMonth(usage, appointment.clientCode, month);
  const left = remainingFree(usage, appointment.clientCode, month);

  return (
    <article className={`record-card booking ${frozen ? "frozen" : ""}`}>
      <div className="record-index">{appointment.id.slice(-2)}</div>
      <div className="booking-body">
        <div className="booking-head">
          <h3>
            {appointment.clientCode}
            <span className={`status-pill ${frozen ? "pill-confirmed" : "pill-pending"}`}>
              {appointment.status}
            </span>
          </h3>
          <p>
            {appointment.counselor} · {appointment.format} · {formatRange(appointment.start, appointment.end)}
          </p>
          <p className="hint">
            {appointment.clientCode} 本月改期：已用 {used}/{FREE_RESHEDULES_PER_MONTH}
            {left > 0 ? `，剩 ${left} 次免费` : "，免费额度已用完"}
          </p>
        </div>

        {!editing && (
          <div className="booking-actions">
            {!frozen && (
              <button className="primary-action small" onClick={() => onConfirm(appointment.id)}>
                确认会谈（冻结）
              </button>
            )}
            <button onClick={() => onStartEdit(appointment, "reschedule")}>改期</button>
            <button onClick={() => onStartEdit(appointment, "correct")}>
              {frozen ? "更正（留痕新版本）" : "更正预约"}
            </button>
            {!frozen && (
              <button className="danger" onClick={() => onWithdraw(appointment.id)}>
                撤销（释放时段）
              </button>
            )}
          </div>
        )}

        {editing && edit && (
          <div className="edit-panel">
            <div className="edit-title">
              {edit.mode === "reschedule" ? "改期申请" : "更正预约"}
              {frozen && <span className="frozen-note">该预约已冻结，更正将另存带原因的新版本</span>}
            </div>
            <div className="field-grid">
              <label>
                <span>开始时刻</span>
                <input
                  type="datetime-local"
                  value={edit.start}
                  onChange={(e) => onEdit({ ...edit, start: e.target.value })}
                />
              </label>
              <label>
                <span>结束时刻</span>
                <input
                  type="datetime-local"
                  value={edit.end}
                  onChange={(e) => onEdit({ ...edit, end: e.target.value })}
                />
              </label>
              <label className={edit.mode === "reschedule" ? "disabled-field" : ""}>
                <span>咨询师{edit.mode === "reschedule" ? "（改期不可改）" : ""}</span>
                <select
                  value={edit.counselor}
                  disabled={edit.mode === "reschedule"}
                  onChange={(e) => onEdit({ ...edit, counselor: e.target.value })}
                >
                  {COUNSELORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className={edit.mode === "reschedule" ? "disabled-field" : ""}>
                <span>形式{edit.mode === "reschedule" ? "（改期不可改）" : ""}</span>
                <select
                  value={edit.format}
                  disabled={edit.mode === "reschedule"}
                  onChange={(e) => onEdit({ ...edit, format: e.target.value as SessionFormat })}
                >
                  {FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <QuotaGate edit={edit} left={left} frozen={frozen} onEdit={onEdit} />

            {editBlocked.length > 0 && (
              <div className="blocked-inline">
                <BlockedList blocked={editBlocked} />
              </div>
            )}

            <div className="booking-actions">
              <button className="primary-action small" onClick={() => onSubmitEdit(appointment)}>
                {edit.mode === "reschedule" ? "提交改期" : "另存更正版本"}
              </button>
              <button onClick={onCancelEdit}>取消（继续占用原时段）</button>
            </div>
          </div>
        )}

        <details className="versions" open={editing}>
          <summary>版本历史（v{appointment.versions.length}）</summary>
          <ol>
            {appointment.versions.map((v) => (
              <li key={v.version}>
                <div className="version-line">
                  <strong>v{v.version}</strong>
                  <span className={`kind kind-${v.kind}`}>{v.kind}</span>
                  <span>{formatStamp(v.at)}</span>
                  {v.charged && <span className="charge-tag">计入改期额度</span>}
                  {v.supervisor && <span className="supervisor-tag">督导：{v.supervisor}</span>}
                </div>
                <p>
                  {v.counselor} · {v.format} · {formatRange(v.start, v.end)}
                </p>
                {v.reason && <p className="version-reason">原因 / 理由：{v.reason}</p>}
              </li>
            ))}
          </ol>
        </details>
      </div>
    </article>
  );
}

// 规则③④：额度还有时免费；额度用完时督导＋理由同时出现才放行
function QuotaGate({
  edit,
  left,
  frozen,
  onEdit,
}: {
  edit: EditForm;
  left: number;
  frozen: boolean;
  onEdit: (f: EditForm) => void;
}) {
  const needApproval = left <= 0;
  const reasonRequired = needApproval || (frozen && edit.mode === "correct");
  return (
    <div className="field-grid quota-gate">
      <label className={needApproval ? "" : "disabled-field"}>
        <span>督导{needApproval ? "（额度已用完，必选）*" : "（尚有免费额度，无需指定）"}</span>
        <select
          value={edit.supervisor}
          disabled={!needApproval}
          onChange={(e) => onEdit({ ...edit, supervisor: e.target.value })}
        >
          <option value="">{needApproval ? "请选择督导" : "无需督导"}</option>
          {SUPERVISORS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>理由 / 更正原因{reasonRequired ? " *" : "（可选）"}</span>
        <input
          placeholder={reasonRequired ? "必填：写明改期理由或更正原因" : "可填写说明"}
          value={edit.reason}
          onChange={(e) => onEdit({ ...edit, reason: e.target.value })}
        />
      </label>
    </div>
  );
}

export default App;
