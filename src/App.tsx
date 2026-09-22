import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  Appointment,
  BlockedReport,
  COUNSELORS,
  FORMATS,
  FREE_RESCHEDULES_PER_MONTH,
  RULES,
  SUPERVISORS,
  SchedulerState,
  findConflicts,
  fmtDateTime,
  fmtSlot,
  freeRemaining,
  loadState,
  monthOf,
  newId,
  reschedulesUsed,
  saveState,
  snapshotOf,
  toLocalInputValue,
  toMs,
} from "./scheduler";

const project = {
  id: "hxwl-12",
  port: 5112,
  title: "会谈预约与改期额度台",
  subtitle:
    "预约单登记来访者代号、咨询师、形式与起止时刻。同一咨询师时段互斥，同一来访者相邻两场留 15 分钟缓冲；每位来访者每月两次免费改期，用完后须指定督导并写理由；会谈确认后预约冻结，更正另存带原因的新版本。",
};

function defaultSlot() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 50);
  return { start: toLocalInputValue(start), end: toLocalInputValue(end) };
}

const initialForm = () => ({
  clientCode: "",
  counselor: COUNSELORS[0],
  format: FORMATS[0],
  ...defaultSlot(),
});

function MetricCard({ label, value, index }: { label: string; value: number; index: number }) {
  const colors = ["status-ok", "status-watch", "status-danger", "status-ok"];
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={colors[index % colors.length]} />
    </article>
  );
}

function BlockedView({ report, onDismiss }: { report: BlockedReport; onDismiss: () => void }) {
  return (
    <section className={`blocked-report kind-${report.kind}`} role="alert">
      <div className="blocked-head">
        <strong>⚠ {report.action}受阻</strong>
        <button type="button" onClick={onDismiss}>知道了</button>
      </div>
      <div className="blocked-grid">
        <div>
          <span>来访者</span>
          <strong>{report.clientCode || "—"}</strong>
        </div>
        <div>
          <span>咨询师</span>
          <strong>{report.counselor || "—"}</strong>
        </div>
        <div>
          <span>{report.kind === "quota" ? "原时段（继续占用）" : "冲突时段"}</span>
          <strong>{report.slotLabel}</strong>
        </div>
      </div>
      <p className="blocked-rules-title">命中规则</p>
      <ul className="blocked-rules">
        {report.kind === "conflict" ? (
          report.hits.map((hit, i) => (
            <li key={i}>
              <em>{hit.rule}</em>
              <span>
                冲突预约：{hit.appointment.clientCode} / {hit.appointment.counselor} /{" "}
                {fmtSlot(hit.appointment.start, hit.appointment.end)}（
                {hit.appointment.status === "confirmed" ? "已确认" : "待确认"}）
              </span>
            </li>
          ))
        ) : (
          <li>
            <em>{report.kind === "quota" ? RULES.rescheduleQuota : "填写校验"}</em>
            <span>{report.message}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

export default function App() {
  const [state, setState] = useState<SchedulerState>(loadState);
  const [form, setForm] = useState(initialForm);
  const [blocked, setBlocked] = useState<BlockedReport | null>(null);

  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rform, setRform] = useState({ start: "", end: "", supervisor: "", reason: "" });

  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [cform, setCform] = useState({ clientCode: "", counselor: "", format: "", reason: "" });

  const [openVersions, setOpenVersions] = useState<Record<string, boolean>>({});

  useEffect(() => saveState(state), [state]);

  const { appointments, reschedules } = state;
  const sortedAppointments = useMemo(
    () => [...appointments].sort((a, b) => toMs(a.start) - toMs(b.start)),
    [appointments]
  );
  const clientCodes = useMemo(
    () => [...new Set(appointments.map((a) => a.clientCode))].sort(),
    [appointments]
  );

  const todayKey = toLocalInputValue(new Date()).slice(0, 10);
  const thisMonth = todayKey.slice(0, 7);
  const metrics = [
    { label: "今日会谈", value: appointments.filter((a) => a.start.slice(0, 10) === todayKey).length },
    { label: "已确认冻结", value: appointments.filter((a) => a.status === "confirmed").length },
    { label: "本月改期", value: reschedules.filter((r) => r.month === thisMonth).length },
    { label: "在册来访者", value: clientCodes.length },
  ];

  const quotaRows = useMemo(() => {
    const map = new Map<string, { clientCode: string; month: string; used: number }>();
    for (const a of appointments) {
      const key = `${a.clientCode}|${monthOf(a.start)}`;
      if (!map.has(key)) map.set(key, { clientCode: a.clientCode, month: monthOf(a.start), used: 0 });
    }
    for (const r of reschedules) {
      const key = `${r.clientCode}|${r.month}`;
      const row = map.get(key) ?? { clientCode: r.clientCode, month: r.month, used: 0 };
      row.used += 1;
      map.set(key, row);
    }
    return [...map.values()].sort(
      (x, y) => x.clientCode.localeCompare(y.clientCode) || x.month.localeCompare(y.month)
    );
  }, [appointments, reschedules]);

  // ---------- 新建预约 ----------

  function submitBooking() {
    const candidate = { ...form, clientCode: form.clientCode.trim() };
    const base = {
      anchor: "booking",
      action: "新建预约",
      clientCode: candidate.clientCode,
      counselor: candidate.counselor,
      slotLabel: candidate.start && candidate.end ? fmtSlot(candidate.start, candidate.end) : "—",
    };
    if (!candidate.clientCode || !candidate.start || !candidate.end) {
      return setBlocked({ ...base, kind: "invalid", hits: [], message: "请完整填写来访者代号、咨询师、形式与起止时刻。" });
    }
    if (toMs(candidate.end) <= toMs(candidate.start)) {
      return setBlocked({ ...base, kind: "invalid", hits: [], message: "结束时刻必须晚于开始时刻。" });
    }
    const hits = findConflicts(appointments, candidate);
    if (hits.length) {
      // 相撞时保留已填内容（不重置表单），并指出冲突预约
      return setBlocked({ ...base, kind: "conflict", hits });
    }
    const appt: Appointment = {
      id: newId("appt"),
      clientCode: candidate.clientCode,
      counselor: candidate.counselor,
      format: candidate.format,
      start: candidate.start,
      end: candidate.end,
      status: "booked",
      createdAt: toLocalInputValue(new Date()),
      confirmedAt: null,
      versions: [],
    };
    appt.versions = [{ version: 1, at: appt.createdAt, reason: "创建预约", snapshot: snapshotOf(appt) }];
    setState((prev) => ({ ...prev, appointments: [...prev.appointments, appt] }));
    setForm(initialForm());
    setBlocked(null);
  }

  // ---------- 确认（冻结） ----------

  function confirmAppointment(appt: Appointment) {
    const stamp = toLocalInputValue(new Date());
    setState((prev) => ({
      ...prev,
      appointments: prev.appointments.map((a) =>
        a.id === appt.id ? { ...a, status: "confirmed", confirmedAt: stamp } : a
      ),
    }));
  }

  // ---------- 改期 ----------

  function openReschedule(appt: Appointment) {
    setCorrectingId(null);
    setBlocked(null);
    setReschedulingId(appt.id);
    setRform({ start: appt.start, end: appt.end, supervisor: "", reason: "" });
  }

  function submitReschedule(appt: Appointment) {
    const { start, end, supervisor, reason } = rform;
    const base = {
      anchor: appt.id,
      action: `改期 ${appt.clientCode}`,
      clientCode: appt.clientCode,
      counselor: appt.counselor,
    };
    if (!start || !end || toMs(end) <= toMs(start)) {
      return setBlocked({
        ...base,
        kind: "invalid",
        slotLabel: "—",
        hits: [],
        message: "请填写完整的新起止时刻，且结束时刻须晚于开始时刻。",
      });
    }
    const attempted = fmtSlot(start, end);
    const hits = findConflicts(
      appointments,
      { clientCode: appt.clientCode, counselor: appt.counselor, start, end },
      appt.id
    );
    if (hits.length) {
      return setBlocked({ ...base, kind: "conflict", slotLabel: attempted, hits });
    }
    const month = monthOf(appt.start);
    const used = reschedulesUsed(reschedules, appt.clientCode, month);
    const overQuota = used >= FREE_RESCHEDULES_PER_MONTH;
    if (overQuota && (!supervisor || !reason.trim())) {
      // 缺督导或理由：改期不生效，原时段继续占用、不释放给他人
      return setBlocked({
        ...base,
        kind: "quota",
        slotLabel: fmtSlot(appt.start, appt.end),
        hits: [],
        message: `该来访者 ${month} 月免费改期已用完（${used}/${FREE_RESCHEDULES_PER_MONTH}），须指定督导并填写理由。本次改期未生效，原时段继续占用、不释放给他人。`,
      });
    }
    const stamp = toLocalInputValue(new Date());
    const record = {
      id: newId("rs"),
      appointmentId: appt.id,
      clientCode: appt.clientCode,
      counselor: appt.counselor,
      month,
      from: { start: appt.start, end: appt.end },
      to: { start, end },
      supervisor: overQuota ? supervisor : null,
      reason: reason.trim() ? reason.trim() : null,
      usedFreeQuota: !overQuota,
      at: stamp,
    };
    setState((prev) => ({
      ...prev,
      reschedules: [...prev.reschedules, record],
      appointments: prev.appointments.map((a) => {
        if (a.id !== appt.id) return a;
        const updated = { ...a, start, end };
        // 已冻结的预约，改期同样另存新版本
        if (a.status === "confirmed") {
          updated.versions = [
            ...a.versions,
            {
              version: a.versions.length + 1,
              at: stamp,
              reason: reason.trim() || "改期",
              snapshot: snapshotOf(updated),
            },
          ];
        }
        return updated;
      }),
    }));
    setReschedulingId(null);
    setBlocked(null);
  }

  // ---------- 冻结后更正（另存新版本） ----------

  function openCorrection(appt: Appointment) {
    setReschedulingId(null);
    setBlocked(null);
    setCorrectingId(appt.id);
    setCform({ clientCode: appt.clientCode, counselor: appt.counselor, format: appt.format, reason: "" });
  }

  function submitCorrection(appt: Appointment) {
    const { clientCode, counselor, format, reason } = cform;
    const base = {
      anchor: appt.id,
      action: `更正 ${appt.clientCode}`,
      clientCode: clientCode.trim(),
      counselor,
      slotLabel: fmtSlot(appt.start, appt.end),
    };
    if (!clientCode.trim()) {
      return setBlocked({ ...base, kind: "invalid", hits: [], message: "来访者代号不能为空。" });
    }
    if (!reason.trim()) {
      return setBlocked({ ...base, kind: "invalid", hits: [], message: "预约已冻结，更正必须填写原因，另存为新版本。" });
    }
    const hits = findConflicts(
      appointments,
      { clientCode: clientCode.trim(), counselor, start: appt.start, end: appt.end },
      appt.id
    );
    if (hits.length) {
      return setBlocked({ ...base, kind: "conflict", hits });
    }
    const stamp = toLocalInputValue(new Date());
    setState((prev) => ({
      ...prev,
      appointments: prev.appointments.map((a) => {
        if (a.id !== appt.id) return a;
        const updated = { ...a, clientCode: clientCode.trim(), counselor, format };
        updated.versions = [
          ...a.versions,
          { version: a.versions.length + 1, at: stamp, reason: reason.trim(), snapshot: snapshotOf(updated) },
        ];
        return updated;
      }),
    }));
    setCorrectingId(null);
    setBlocked(null);
  }

  // ---------- 渲染 ----------

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">{project.id} · port {project.port}</p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>规则速览</span>
          <ul className="rule-list">
            <li>{RULES.counselorOverlap}</li>
            <li>{RULES.clientBuffer}</li>
            <li>{RULES.rescheduleQuota}</li>
            <li>{RULES.frozen}</li>
          </ul>
        </div>
      </section>

      <section className="metrics-grid">
        {metrics.map((m, i) => (
          <MetricCard key={m.label} label={m.label} value={m.value} index={i} />
        ))}
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>咨询师</h2>
          <div className="chips">
            {COUNSELORS.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <h2>督导</h2>
          <div className="chips">
            {SUPERVISORS.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
          <h2>改期额度（每月免费 {FREE_RESCHEDULES_PER_MONTH} 次）</h2>
          <table className="quota-table">
            <thead>
              <tr>
                <th>来访者</th>
                <th>月份</th>
                <th>已用</th>
                <th>剩余</th>
              </tr>
            </thead>
            <tbody>
              {quotaRows.map((row) => (
                <tr key={`${row.clientCode}-${row.month}`}>
                  <td>{row.clientCode}</td>
                  <td>{row.month}</td>
                  <td>{row.used}</td>
                  <td className={row.used >= FREE_RESCHEDULES_PER_MONTH ? "quota-empty" : "quota-left"}>
                    {Math.max(0, FREE_RESCHEDULES_PER_MONTH - row.used)}
                  </td>
                </tr>
              ))}
              {quotaRows.length === 0 && (
                <tr>
                  <td colSpan={4}>暂无来访者</td>
                </tr>
              )}
            </tbody>
          </table>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>预约单</p>
              <h2>新建会谈预约</h2>
            </div>
          </div>
          <div className="field-grid">
            <label>
              <span>来访者代号</span>
              <input
                list="client-codes"
                placeholder="如 C-042"
                value={form.clientCode}
                onChange={(e) => setForm({ ...form, clientCode: e.target.value })}
              />
              <datalist id="client-codes">
                {clientCodes.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label>
              <span>咨询师</span>
              <select value={form.counselor} onChange={(e) => setForm({ ...form, counselor: e.target.value })}>
                {COUNSELORS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              <span>形式</span>
              <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                {FORMATS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              <span>开始时刻</span>
              <input
                type="datetime-local"
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </label>
            <label>
              <span>结束时刻</span>
              <input
                type="datetime-local"
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </label>
          </div>
          <div className="form-footer">
            <button className="primary-action" onClick={submitBooking}>
              提交预约
            </button>
            <span className="muted">时段相撞时保留已填内容，并指出冲突预约。</span>
          </div>
          {blocked?.anchor === "booking" && <BlockedView report={blocked} onDismiss={() => setBlocked(null)} />}
        </section>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>排期</p>
            <h2>预约列表（{appointments.length}）</h2>
          </div>
        </div>
        <div className="record-list">
          {sortedAppointments.map((appt) => {
            const month = monthOf(appt.start);
            const left = freeRemaining(reschedules, appt.clientCode, month);
            return (
              <article key={appt.id} className={`appt-card ${appt.status}`}>
                <div className="appt-main">
                  <div className="appt-title">
                    <strong>{appt.clientCode}</strong>
                    <span className={`badge ${appt.status}`}>
                      {appt.status === "confirmed" ? "已确认 · 冻结" : "待确认"}
                    </span>
                    <span className="muted">v{appt.versions.length}</span>
                  </div>
                  <p>
                    {appt.counselor} · {appt.format} · {fmtSlot(appt.start, appt.end)}
                  </p>
                </div>
                <div className="appt-actions">
                  {appt.status === "booked" && (
                    <button className="primary-action" onClick={() => confirmAppointment(appt)}>
                      确认会谈
                    </button>
                  )}
                  <button onClick={() => (reschedulingId === appt.id ? setReschedulingId(null) : openReschedule(appt))}>
                    改期
                  </button>
                  {appt.status === "confirmed" && (
                    <button onClick={() => (correctingId === appt.id ? setCorrectingId(null) : openCorrection(appt))}>
                      更正存档
                    </button>
                  )}
                  <button
                    className="ghost-btn"
                    onClick={() => setOpenVersions((v) => ({ ...v, [appt.id]: !v[appt.id] }))}
                  >
                    版本（{appt.versions.length}）
                  </button>
                </div>

                {reschedulingId === appt.id && (
                  <div className="inline-form">
                    <h3>改期 — {appt.clientCode} / {appt.counselor}</h3>
                    <p className={left > 0 ? "quota-hint" : "quota-hint warn"}>
                      {month} 月免费改期剩余 {left} 次
                      {left === 0 && "：额度已用完，须指定督导并填写理由，否则原时段继续占用、不释放给他人。"}
                    </p>
                    <div className="field-grid">
                      <label>
                        <span>新开始时刻</span>
                        <input
                          type="datetime-local"
                          value={rform.start}
                          onChange={(e) => setRform({ ...rform, start: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>新结束时刻</span>
                        <input
                          type="datetime-local"
                          value={rform.end}
                          onChange={(e) => setRform({ ...rform, end: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>督导{left > 0 && "（免费额度内选填）"}</span>
                        <select
                          value={rform.supervisor}
                          onChange={(e) => setRform({ ...rform, supervisor: e.target.value })}
                        >
                          <option value="">请选择督导</option>
                          {SUPERVISORS.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>理由{left > 0 && "（免费额度内选填）"}</span>
                        <input
                          placeholder="改期原因"
                          value={rform.reason}
                          onChange={(e) => setRform({ ...rform, reason: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="form-footer">
                      <button className="primary-action" onClick={() => submitReschedule(appt)}>
                        提交改期
                      </button>
                      <button onClick={() => setReschedulingId(null)}>取消</button>
                    </div>
                    {blocked?.anchor === appt.id && (
                      <BlockedView report={blocked} onDismiss={() => setBlocked(null)} />
                    )}
                  </div>
                )}

                {correctingId === appt.id && (
                  <div className="inline-form">
                    <h3>更正存档 — 另存新版本（当前 v{appt.versions.length}）</h3>
                    <p className="quota-hint">预约已冻结，更正不会改写历史，将另存为带原因的新版本。</p>
                    <div className="field-grid">
                      <label>
                        <span>来访者代号</span>
                        <input
                          value={cform.clientCode}
                          onChange={(e) => setCform({ ...cform, clientCode: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>咨询师</span>
                        <select
                          value={cform.counselor}
                          onChange={(e) => setCform({ ...cform, counselor: e.target.value })}
                        >
                          {COUNSELORS.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>形式</span>
                        <select value={cform.format} onChange={(e) => setCform({ ...cform, format: e.target.value })}>
                          {FORMATS.map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>更正原因（必填）</span>
                        <input
                          placeholder="为何更正"
                          value={cform.reason}
                          onChange={(e) => setCform({ ...cform, reason: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="form-footer">
                      <button className="primary-action" onClick={() => submitCorrection(appt)}>
                        另存新版本
                      </button>
                      <button onClick={() => setCorrectingId(null)}>取消</button>
                    </div>
                    {blocked?.anchor === appt.id && (
                      <BlockedView report={blocked} onDismiss={() => setBlocked(null)} />
                    )}
                  </div>
                )}

                {openVersions[appt.id] && (
                  <ul className="version-list">
                    {appt.versions.map((v) => (
                      <li key={v.version}>
                        <span className="version-tag">v{v.version}</span>
                        <div>
                          <strong>{v.reason}</strong>
                          <p>
                            {v.snapshot.clientCode} / {v.snapshot.counselor} / {v.snapshot.format} /{" "}
                            {fmtSlot(v.snapshot.start, v.snapshot.end)} · 记录于 {fmtDateTime(v.at)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
          {appointments.length === 0 && <p className="muted">暂无预约，请从上方预约单创建。</p>}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>台账</p>
            <h2>改期记录（{reschedules.length}）</h2>
          </div>
        </div>
        <div className="record-list">
          {[...reschedules].reverse().map((r) => (
            <article key={r.id} className="log-card">
              <div className="appt-title">
                <strong>{r.clientCode}</strong>
                <span className={`badge ${r.usedFreeQuota ? "booked" : "confirmed"}`}>
                  {r.usedFreeQuota ? "免费额度" : `督导 · ${r.supervisor}`}
                </span>
                <span className="muted">{r.month}</span>
              </div>
              <p>
                {r.counselor} · {fmtSlot(r.from.start, r.from.end)} → {fmtSlot(r.to.start, r.to.end)}
              </p>
              {r.reason && <p className="muted">理由：{r.reason}</p>}
            </article>
          ))}
          {reschedules.length === 0 && <p className="muted">暂无改期记录。</p>}
        </div>
      </section>
    </main>
  );
}
